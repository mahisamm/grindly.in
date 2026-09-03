import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { COMPANY_DISCLAIMER, COMPANY_PACKS } from "@/lib/companyPacks";
import { paymentsEnabled } from "@/lib/config";
import { limitsFor } from "@/lib/plans";
import { pickPrimary } from "@/lib/primary";
import { readFidelity, readReport, readStrings, readTargetSpec } from "@/lib/reportTypes";
import { TailorClient } from "./TailorClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tailor for a company — Grindly" };

/**
 * Company tailoring, promoted out of the resume workspace into its own place.
 *
 * It is a distinct feature — aim a resume at a published hiring profile or a
 * pasted job description, and it changes what the resume *surfaces*, never what
 * it claims. It operates on the primary resume; an account with several source
 * resumes changes which one is primary from /app/resumes.
 */
export default async function TailorPage() {
  const user = await currentUser();
  if (!user) return null; // the layout already redirected

  const owned = await prisma.resume.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  const primaryRef = pickPrimary(owned, user.primaryResumeId);

  if (!primaryRef) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-12 sm:px-6">
        <h1 className="font-display text-2xl font-bold sm:text-3xl">Tailor for a company</h1>
        <p className="text-muted mt-3 text-sm leading-relaxed">
          Add a resume first — then you can aim it at a specific company or job
          description.
        </p>
        <Link href="/app/resumes" className="btn btn-primary mt-5">
          Add a resume
        </Link>
      </div>
    );
  }

  const resume = await prisma.resume.findFirst({
    where: { id: primaryRef.id, userId: user.id },
    include: {
      variants: { where: { archivedAt: null }, orderBy: [{ createdAt: "desc" }] },
      targets: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!resume) return null;

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-6 sm:py-10">
      <h1 className="font-display text-2xl font-bold sm:text-3xl">
        Tailor for a company
      </h1>

      <TailorClient
        resume={{
          id: resume.id,
          label: resume.label,
          chars: resume.chars,
          truncated: resume.truncated,
          shareToken: resume.shareToken,
          linkStyle: resume.linkStyle,
          text: resume.text,
          report: readReport(resume.reportJson),
          advice: null,
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
            canPromote: Boolean(v.structJson) && v.text.trim().length > 0,
            createdAt: v.createdAt.toISOString(),
          })),
          history: [],
          applications: [],
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
        targetLimit={limitsFor(user).targetsPerResume}
        paymentsLive={paymentsEnabled()}
        freeCompanyRebuildAvailable={!user.freeCompanyRunId}
        otherResumeCount={owned.length - 1}
      />
    </div>
  );
}
