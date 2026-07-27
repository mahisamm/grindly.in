import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { releaseDailySlot } from "@/lib/browserTasks";

// POST /api/autopilot/tasks/:id/retry — put a stopped task back in the queue.
//
// Without this a task that stops at a human gate is stuck forever: nothing
// requeues `awaiting_human` on purpose (the lease reclaimer refuses to, because
// re-running a task that might have submitted is the duplicate this system
// spends most of its effort preventing). That is right for an automatic retry
// and wrong as the only option — a user who has cleared the CAPTCHA, answered
// the question, or watched Grindly press the wrong button has no way to say
// "try that again", and the whole queue silently dies.
//
// So the retry exists, but only a person can ask for it, and only where a
// second attempt cannot duplicate a real application.
export const dynamic = "force-dynamic";

/** States a person may put back in the queue — none of them can have submitted. */
const RETRYABLE = new Set(["awaiting_human", "failed"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { id } = await ctx.params;
  const task = await prisma.browserTask.findFirst({
    where: { id, userId: uid },
    select: { id: true, state: true, applicationId: true, reservedDate: true },
  });
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });

  // `submitted` is terminal, and `leased`/`filling` mean a tab is working on it
  // right now — requeueing either would be asking for the second application.
  //
  // `failed` is included because the executor only reports it BEFORE any click:
  // a fill error, or a half-reloaded extension. Leaving it out meant a task
  // killed by a stale extension bundle could never be run again, which is the
  // most likely failure of all right after an update.
  if (!RETRYABLE.has(task.state)) {
    return NextResponse.json(
      { error: "not_retryable", state: task.state },
      { status: 409 },
    );
  }

  // The strongest duplicate guard available: if the application is already
  // recorded as applied, something reached the employer. Never send it twice,
  // whatever the task row says.
  const app = await prisma.application.findUnique({
    where: { id: task.applicationId },
    select: { status: true },
  });
  if (app && ["applied", "needs_review"].includes(app.status)) {
    return NextResponse.json(
      { error: "already_applied", status: app.status },
      { status: 409 },
    );
  }

  // Conditioned on the state so two clicks cannot queue it twice.
  const { count } = await prisma.browserTask.updateMany({
    where: { id: task.id, userId: uid, state: task.state },
    data: {
      state: "queued",
      // A person asked for this, so the automatic attempt budget starts over.
      attempts: 0,
      blockedReason: null,
      leaseTokenHash: null,
      leaseExpiresAt: null,
      reservedDate: null,
    },
  });
  if (count !== 1) return NextResponse.json({ error: "not_retryable" }, { status: 409 });

  // The stopped attempt was still holding its reserved slot (awaiting_human
  // holds no lease, so the reclaimer never touches it). The re-queue above just
  // cleared reservedDate; give the slot back too, or every user-asked retry
  // permanently eats one of the day's applications — re-claiming reserves a
  // fresh slot for the new attempt.
  if (task.reservedDate) await releaseDailySlot(uid, task.reservedDate);

  await prisma.applicationEvent
    .create({
      data: {
        applicationId: task.applicationId,
        type: "requeued",
        actor: "user",
        meta: JSON.stringify({ from: "awaiting_human" }),
      },
    })
    .catch(() => {});

  return NextResponse.json({ ok: true, state: "queued" });
}
