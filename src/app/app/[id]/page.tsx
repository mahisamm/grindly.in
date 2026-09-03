import { Suspense } from "react";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { toJsonColumn } from "@/lib/jsonColumn";
import { currentUser } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { COMPANY_DISCLAIMER, COMPANY_PACKS } from "@/lib/companyPacks";
import { paymentsEnabled } from "@/lib/config";
import { limitsFor } from "@/lib/plans";
import {
  readAdvice, readFidelity, readReport, readStrings, readTargetSpec,
} from "@/lib/reportTypes";
import { ResumeWorkspace } from "./Workspace";

export const dynamic = "force-dynamic";

export default async function ResumePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return null;
  const { id } = await params;

  const resume = await prisma.resume.findFirst({
    where: { id, userId: user.id },
    include: {
      variants: { where: { archivedAt: null }, orderBy: [{ createdAt: "desc" }] },
      targets: { orderBy: { createdAt: "desc" } },
      // Oldest first: this is a line on a chart, and a chart reads left to
      // right through time.
      scores: { orderBy: { createdAt: "asc" }, take: 100 },
      applications: { orderBy: { appliedAt: "desc" }, take: 200 },
    },
  });
  if (!resume) notFound();

  // Resumes uploaded before the career-stage read existed have no stage on
  // the row. Read it once here (deterministic, well under a second) and keep
  // it, so the one-page suggestion reaches existing users too. Pages, when
  // the upload never recorded them, are estimated the way ingest does.
  if (!resume.careerStage && resume.text.trim().length > 200) {
    const scored = await runAgent<{ profile?: { stage: string; signals: string[] } }>("report", {
      text: resume.text,
    });
    if (scored.ok && scored.profile) {
      const pages = resume.pages ?? Math.max(1, Math.ceil(resume.text.trim().length / 3200));
      await prisma.resume
        .update({
          where: { id: resume.id },
          data: {
            careerStage: scored.profile.stage,
            careerSignals: toJsonColumn(scored.profile.signals),
            pages,
          },
        })
        .catch(() => null);
      resume.careerStage = scored.profile.stage;
      resume.careerSignals = scored.profile.signals;
      resume.pages = pages;
    }
  }


  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-6 sm:py-10">
      {/* No back link: the top nav's RESUMES / REPORT and the phone bar are the
          way around the app now. */}
      {/* The workspace reads `?tab=` with useSearchParams, which suspends. The
          boundary is here rather than around the whole page so the heading is
          painted immediately — it does not depend on the query string. */}
      <Suspense fallback={<WorkspaceSkeleton />}>
      <ResumeWorkspace
        resume={{
          id: resume.id,
          label: resume.label,
          chars: resume.chars,
          truncated: resume.truncated,
          shareToken: resume.shareToken,
          linkStyle: resume.linkStyle,
          text: resume.text,
          report: readReport(resume.reportJson),
          advice: readAdvice(resume.adviceJson),
          skills: readStrings(resume.skillsJson),
          pages: resume.pages,
          careerStage: resume.careerStage,
          careerSignals: readStrings(resume.careerSignals),
          targetPages: resume.targetPages,
          variants: resume.variants.map((v) => ({
            id: v.id,
            label: v.label,
            score: v.score,
            grade: v.grade,
            baselineScore: v.baselineScore,
            beatsBaseline: v.beatsBaseline,
            pages: v.pages,
            targetId: v.targetId,
            changes: readStrings(v.changesJson),
            report: readReport(v.reportJson),
            fidelity: readFidelity(v.fidelityJson),
            // Derived here rather than sending the fields themselves. The
            // struct and the read-back text are several kilobytes per rebuild
            // and nothing on the page renders either of them — all the card
            // needs to know is whether the button can be offered at all.
            canPromote: Boolean(v.structJson) && v.text.trim().length > 0,
            createdAt: v.createdAt.toISOString(),
          })),
          history: resume.scores.map((h) => ({
            id: h.id,
            score: h.score,
            grade: h.grade,
            source: h.source,
            variantLabel: h.variantLabel,
            createdAt: h.createdAt.toISOString(),
          })),
          applications: resume.applications.map((a) => ({
            id: a.id,
            company: a.company,
            role: a.role,
            status: a.status,
            variantLabel: a.variantLabel,
            notes: a.notes,
            appliedAt: a.appliedAt.toISOString(),
          })),
          targets: resume.targets.map((t) => ({
            id: t.id,
            kind: t.kind,
            name: t.name,
            slug: t.slug,
            spec: readTargetSpec(t.specJson),
          })),
        }}
        packs={COMPANY_PACKS}
        disclaimer={COMPANY_DISCLAIMER}
        // How many company targets this plan allows per resume, so the tab can
        // say so BEFORE the user picks one. Without it, a free user who has
        // already tailored for one company clicks "Tailor for Freshworks",
        // waits, and is answered with a 402 telling them to buy a pass — an
        // upgrade prompt as the response to a button that looked available.
        targetLimit={limitsFor(user).targetsPerResume}
        paymentsLive={paymentsEnabled()}
        freeCompanyRebuildAvailable={!user.freeCompanyRunId}
      />
      </Suspense>
    </div>
  );
}

/**
 * The shape of the workspace while it resolves — a heading, a tab row and a
 * card, at the sizes the real thing uses.
 *
 * Sized deliberately rather than left as a spinner: a fallback with different
 * dimensions to the content it stands in for makes the page jump when it
 * arrives, which reads as a bug on a fast connection and as two separate loads
 * on a slow one.
 */
function WorkspaceSkeleton() {
  return (
    <div className="mt-4 animate-pulse" aria-hidden="true">
      <div className="h-9 w-64 rounded" style={{ background: "var(--surface-2)" }} />
      <div className="border-border mt-6 flex gap-4 border-b pb-3">
        {[88, 96, 140, 168].map((w) => (
          <div key={w} className="h-4 rounded" style={{ width: w, background: "var(--surface-2)" }} />
        ))}
      </div>
      <div className="mt-8 grid gap-10 lg:grid-cols-[1.4fr_1fr]">
        <div className="h-64 rounded-xl" style={{ background: "var(--surface-2)" }} />
        <div className="h-40 rounded-xl" style={{ background: "var(--surface-2)" }} />
      </div>
    </div>
  );
}
