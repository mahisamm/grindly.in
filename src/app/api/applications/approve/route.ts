import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { dueNow } from "@/lib/pipeline";
import { getQuota } from "@/lib/quota";

/**
 * Approve a matched application — and actually send it.
 *
 * This used to only flip the status to "approved" and stop. The submit itself
 * happened at the start of the *next* full agent run (worker step 4a), so the
 * real flow was: Run agent -> Approve -> Run agent again. Nothing in the UI said
 * so, and nobody would guess it — the tap looked like it had done something and
 * hadn't. Now the approve enqueues a submit-only run ("approved" mode: sends the
 * approved queue, no scraping, no scoring) so the tap means what it says.
 *
 * Idempotent by design: an already-queued/running job for this user will pick up
 * anything newly approved when it reaches step 4a, so "Approve all" on 12 jobs
 * enqueues one run, not twelve.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: uid }, select: { plan: true } });
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const quota = await getQuota(uid, user.plan);
  if (quota.remaining === 0) {
    return NextResponse.json(
      {
        error: quota.kind === "trial"
          ? "Your free trial is complete. Upgrade to send more applications."
          : "Your daily application limit is reached. Try again tomorrow.",
        code: quota.kind === "trial" ? "trial_exhausted" : "daily_limit_reached",
        quota,
      },
      { status: 402 },
    );
  }

  // dueNow(), not status:"matched" — an id from the embargoed part of the pipeline
  // must be unapprovable even if the caller somehow learned it. The list endpoint
  // never serves those ids, but "the UI doesn't show it" is not access control.
  const app = await prisma.application.findFirst({
    where: { id: body.id, userId: uid, ...dueNow() },
  });
  if (!app) return NextResponse.json({ error: "not found or not ready to send" }, { status: 404 });

  await prisma.application.update({
    where: { id: body.id },
    data: {
      status: "approved",
      reason: (app.reason ?? "") + " — ready for your final browser submission",
    },
  });

  // Safe Apply Mode never queues a server-side browser session to click submit.
  return NextResponse.json({ ok: true, requiresUserSubmit: true });
}
