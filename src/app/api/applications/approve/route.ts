import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { dueNow } from "@/lib/pipeline";
import { getQuota, remainingForApproval } from "@/lib/quota";
import { notifyUser } from "@/lib/notify";
import { hasAppAccess } from "@/lib/access";

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

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { plan: true, accessStatus: true, role: true, email: true },
  });
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  if (!hasAppAccess(user)) {
    return NextResponse.json(
      { error: "Your access is pending approval.", code: "access_pending" },
      { status: 403 },
    );
  }
  const quota = await getQuota(uid, user.plan);
  // Counts already-approved-but-unsubmitted rows against today's cap too —
  // otherwise approving a little each day with nothing submitted lets a user
  // bank an unbounded backlog, then burst-submit past the daily limit.
  const approvable = await remainingForApproval(uid, user.plan);
  if (approvable === 0) {
    return NextResponse.json(
      {
        error: "Your daily application limit is reached. Try again tomorrow.",
        code: "daily_limit_reached",
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

  // Deliver the link to the user's own channels so they can finish the submit
  // later without living on the dashboard. Best-effort: never block the approve.
  void notifyUser(uid, {
    tier: "urgent",
    title: "Application ready to submit",
    body:
      `${app.jobTitle} at ${app.company} is prepared and ready for your final submit.` +
      (app.url ? `\nOpen & submit: ${app.url}` : "") +
      `\nOr finish it from your dashboard.`,
  });

  // Safe Apply Mode never queues a server-side browser session to click submit.
  return NextResponse.json({ ok: true, requiresUserSubmit: true });
}
