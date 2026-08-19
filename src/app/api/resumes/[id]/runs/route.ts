import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, notFound } from "@/lib/auth";
import { reapStaleRuns } from "@/lib/variantRuns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * What is happening, or what happened last, to this resume.
 *
 * The page polls this while a rebuild is in flight and reads it once on a cold
 * load — which is the half that matters. Before runs were rows, a batch existed
 * only as an open request: refresh the page mid-rebuild and there was nothing
 * anywhere to say that three minutes of work was under way on your behalf.
 *
 * Stale runs are reaped on the way in rather than by a scheduler. There is no
 * scheduler in this deployment, and the only moment anyone cares whether a run
 * is really still running is the moment they ask.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  // Ownership in the WHERE, not checked after the read.
  const resume = await prisma.resume.findFirst({
    where: { id, userId: auth.user.id },
    select: { id: true },
  });
  if (!resume) return notFound();

  await reapStaleRuns(resume.id);

  const runs = await prisma.variantRun.findMany({
    where: { resumeId: resume.id },
    orderBy: { startedAt: "desc" },
    // Enough to show the one in flight plus the last few outcomes, and few
    // enough that a poll every two seconds stays cheap.
    take: 5,
    select: {
      id: true, status: true, stage: true, error: true, targetId: true,
      targetName: true, variantsMade: true, startedAt: true, finishedAt: true,
    },
  });

  return NextResponse.json(
    { ok: true, runs, active: runs.find((r) => r.status === "running") ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}
