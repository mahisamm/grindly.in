import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { dueNow } from "@/lib/pipeline";
import { getQuota, remainingForApproval } from "@/lib/quota";
import { notifyUser } from "@/lib/notify";
import { hasAppAccess } from "@/lib/access";
import { agentWillSend, approvalOutcomeMessage } from "@/lib/applyPolicy";
import { enqueueAgentRun } from "@/lib/agentRunQueue";
import { spawnWorkerKick } from "@/lib/workerKick";
import { readAdminSettings } from "@/lib/adminSettings";

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

  // What happens next depends on where this application is actually delivered.
  // A row routed to an employer's own intake (Google Form, HR mailbox) is sent
  // by the agent on its next run; one that only exists on a board still needs
  // the user's own browser. Telling someone to go finish an application the
  // agent already sent is the same failure as promising one that never goes.
  // The admin kill switch has to count here too. It was enforced only in
  // api/agent/run, so an admin turning auto-apply off stopped new discovery runs
  // while Approve went on enqueueing submit runs — applications kept going out
  // from the one surface nobody thought to check. Folding it into `willSend`
  // rather than bolting it onto the enqueue keeps the user's message honest as
  // well: they get "ready for your final browser submission", not a promise the
  // fleet has been told not to keep.
  const autoApplyEnabled = readAdminSettings().featureFlags.autoApply;
  const willSend = autoApplyEnabled && agentWillSend(app);
  const outcome = willSend
    ? approvalOutcomeMessage(app)
    : "ready for your final browser submission";

  await prisma.application.update({
    where: { id: body.id },
    data: {
      status: "approved",
      reason: (app.reason ?? "") + ` — ${outcome}`,
      // Dates the quota reservation so it expires with today (see lib/quota.ts).
      approvedAt: new Date(),
    },
  });

  // Deliver the link to the user's own channels so they can finish the submit
  // later without living on the dashboard. Best-effort: never block the approve.
  void notifyUser(uid, {
    tier: "urgent",
    title: willSend ? "Application queued to send" : "Application ready to submit",
    body: willSend
      ? `${app.jobTitle} at ${app.company} — ${outcome}. You'll see it on your dashboard once it's sent.`
      : `${app.jobTitle} at ${app.company} is prepared and ready for your final submit.` +
        (app.url ? `\nOpen & submit: ${app.url}` : "") +
        `\nOr finish it from your dashboard.`,
  });

  // Actually queue the submit run the docstring and the notification above both
  // promise. This was missing: the row was flipped to "approved", the user was
  // told "queued to send", and nothing was enqueued — the submit waited for the
  // next manual run or the daily sweep, which is exactly the confusing
  // Run -> Approve -> Run again flow this endpoint was written to remove.
  //
  // Only when the agent is the one sending. A board row the user has to submit
  // in their own browser gives the worker nothing to do, and queuing a run for
  // it would spend a slot to no effect.
  //
  // Idempotent: enqueueAgentRun collapses on activeKey `${uid}:approved`, so
  // "Approve all" over twelve rows still enqueues one run, and an already
  // queued/running one picks up everything newly approved when it gets there.
  if (willSend) {
    try {
      await enqueueAgentRun(uid, "approved");
      spawnWorkerKick(process.cwd(), uid);
    } catch (e) {
      // Never fail the approve over this. The row is approved either way, and
      // the daily sweep still sends it if the kick did not land.
      console.error("[approve] could not enqueue the submit run:", e);
    }
  }

  // Board destinations never queue a server-side browser session to click submit.
  return NextResponse.json({ ok: true, requiresUserSubmit: !willSend });
}
