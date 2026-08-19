import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, notFound, serverError } from "@/lib/auth";
import { killRun } from "@/lib/variantRuns";
import { refund } from "@/lib/quota";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; runId: string }> };

/**
 * Stop a rebuild that is under way.
 *
 * The quota is handed back, because the user is not getting a document. That is
 * the same rule the failure and "nothing beat your resume" paths follow: this
 * product charges for output, and a batch that was stopped produced none.
 *
 * Killing the subprocess only works while the run belongs to THIS server
 * process — the handle is a signal to a child of it and means nothing anywhere
 * else. When it does not work, the row is still marked cancelled: the person
 * asked to stop, so they should stop seeing a spinner, and the orphaned
 * subprocess will finish into a run nobody is waiting on and be superseded by
 * whatever they do next.
 */
export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id, runId } = await params;

  const run = await prisma.variantRun.findFirst({
    // Ownership through the resume, in the WHERE — a run id from another
    // account must read as "no such run", not as a permission error.
    where: { id: runId, resumeId: id, resume: { userId: auth.user.id } },
    select: { id: true, status: true },
  });
  if (!run) return notFound();

  if (run.status !== "running") {
    // Already finished. Not an error: the poll and the button race every time
    // someone presses cancel just as a run completes.
    return NextResponse.json({ ok: true, status: run.status, alreadyFinished: true });
  }

  const killed = killRun(run.id);

  try {
    await prisma.variantRun.update({
      where: { id: run.id },
      data: {
        status: "cancelled",
        stage: "Cancelled",
        error: null,
        finishedAt: new Date(),
      },
    });
  } catch (e) {
    return serverError("Could not cancel that rebuild.", `runs/${runId}: ${String(e)}`);
  }

  await refund(auth.user.id, "variantRuns");
  await audit(auth.user.id, "run_cancelled", run.id);

  return NextResponse.json({
    ok: true,
    status: "cancelled",
    // Reported honestly rather than claimed: on a multi-process deployment the
    // work may keep going even though the row says stopped.
    stopped: killed,
  });
}
