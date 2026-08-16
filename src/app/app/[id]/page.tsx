import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { currentUser } from "@/lib/auth";
import { runAgent } from "@/lib/agent";
import { limitsFor } from "@/lib/plans";
import type { Advice, CompanyPack, Fidelity, Report } from "@/lib/reportTypes";
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
    <div className="mx-auto max-w-6xl px-6 py-10">
      <Link href="/app" className="text-muted hover:text-ink text-sm">
        ← All resumes
      </Link>
      <ResumeWorkspace
        resume={{
          id: resume.id,
          label: resume.label,
          chars: resume.chars,
          text: resume.text,
          report: parse<Report>(resume.reportJson),
          advice: parse<Advice>(resume.adviceJson),
          skills: parse<string[]>(resume.skillsJson) ?? [],
          variants: resume.variants.map((v) => ({
            id: v.id,
            label: v.label,
            score: v.score,
            grade: v.grade,
            baselineScore: v.baselineScore,
            beatsBaseline: v.beatsBaseline,
            pages: v.pages,
            targetId: v.targetId,
            changes: parse<string[]>(v.changesJson) ?? [],
            report: parse<Report>(v.reportJson),
            fidelity: parse<Fidelity>(v.fidelityJson),
          })),
          targets: resume.targets.map((t) => ({
            id: t.id,
            kind: t.kind,
            name: t.name,
            slug: t.slug,
            spec: parse<{ skills: string[]; must_have: string[]; nice_to_have: string[] }>(
              t.specJson,
            ),
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

function parse<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
