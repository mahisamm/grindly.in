import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { limitsFor } from "@/lib/plans";
import type { CompanyPack } from "@/lib/reportTypes";
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
      variants: { orderBy: [{ createdAt: "desc" }] },
      targets: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!resume) notFound();

  const packs = await runAgent<{ packs: CompanyPack[]; disclaimer: string }>("companies");

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-6 sm:py-10">
      <Link
        href="/app"
        // min-h-6 + inline-flex: a standalone navigation link needs a target a
        // thumb can hit. WCAG 2.2 exempts links inside a sentence; this is not
        // one, it is the only way back on a phone.
        className="text-muted hover:text-ink inline-flex min-h-6 items-center text-sm"
      >
        ← All resumes
      </Link>
      <ResumeWorkspace
        resume={{
          id: resume.id,
          label: resume.label,
          chars: resume.chars,
          truncated: resume.truncated,
          text: resume.text,
          report: readReport(resume.reportJson),
          advice: readAdvice(resume.adviceJson),
          skills: readStrings(resume.skillsJson),
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
          })),
          targets: resume.targets.map((t) => ({
            id: t.id,
            kind: t.kind,
            name: t.name,
            slug: t.slug,
            spec: readTargetSpec(t.specJson),
          })),
        }}
        packs={packs.ok ? packs.packs : []}
        disclaimer={packs.ok ? packs.disclaimer : ""}
        // How many company targets this plan allows per resume, so the tab can
        // say so BEFORE the user picks one. Without it, a free user who has
        // already tailored for one company clicks "Tailor for Freshworks",
        // waits, and is answered with a 402 telling them to buy a pass — an
        // upgrade prompt as the response to a button that looked available.
        targetLimit={limitsFor(user).targetsPerResume}
      />
    </div>
  );
}
