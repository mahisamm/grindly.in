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

/** Approve TODAY'S matches and enqueue ONE submit-only run to send them. See
 *  api/applications/approve for why the run is needed at all.
 *
 *  "Today's", not "every". The pipeline holds a month of matches; a plain
 *  status:"matched" filter here would approve all ~300 of them in a single tap,
 *  and the worker would then try to fire a month of applications in one sitting.
 *  The daily cap would stop most of it, but the intent is what matters: this
 *  endpoint must never be able to authorize work the user was never shown. */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

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
  // otherwise approving daily with nothing submitted lets a user bank an
  // unbounded backlog, then burst-submit past the daily limit.
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

  const matched = await prisma.application.findMany({
    where: { userId: uid, ...dueNow() },
    select: {
      id: true, reason: true, jobTitle: true, company: true, url: true,
      applyChannel: true, applyTier: true, applyTarget: true,
    },
    take: approvable,
  });
  if (matched.length === 0) return NextResponse.json({ ok: true, approved: 0 });

  // Split the batch by who acts next. A digest that lumps both together sends
  // the user off to "finish" applications the agent is about to send itself.
  const agentSends = matched.filter(agentWillSend);
  const userSends = matched.filter((a) => !agentWillSend(a));

  const approvedAt = new Date();
  await prisma.$transaction(
    matched.map((a) =>
      prisma.application.update({
        where: { id: a.id },
        data: {
          status: "approved",
          reason: (a.reason ?? "") + ` — ${approvalOutcomeMessage(a)}`,
          // Dates the quota reservation so it expires with today (lib/quota.ts).
          approvedAt,
        },
      })
    )
  );

  // One digest, not one message per job. Best-effort — the approve must succeed
  // even if delivery fails or no channel is configured.
  const sections: string[] = [];
  if (agentSends.length > 0) {
    sections.push(
      `I'll send these myself — nothing for you to do:\n\n` +
        agentSends.map((a) => `• ${a.jobTitle} — ${a.company}`).join("\n"),
    );
  }
  if (userSends.length > 0) {
    sections.push(
      `These are on boards that hold your account, so they need your final submit:\n\n` +
        userSends
          .map((a) => `• ${a.jobTitle} — ${a.company}${a.url ? `\n  ${a.url}` : ""}`)
          .join("\n") +
        `\n\nOpen your Grindly dashboard to finish each one.`,
    );
  }
  void notifyUser(uid, {
    tier: "urgent",
    title: `${matched.length} application${matched.length === 1 ? "" : "s"} approved`,
    body: sections.join("\n\n"),
  });

  // Queue the one submit run that covers the whole batch. Same omission as the
  // single-approve endpoint had: rows were marked approved and the digest said
  // "I'll send these myself", but nothing was enqueued, so the sends waited for
  // the next full run or the daily sweep.
  //
  // One run for the batch, not one per row — enqueueAgentRun collapses on
  // activeKey `${uid}:approved`, and the worker's approved-queue step picks up
  // everything that is approved when it gets there.
  if (agentSends.length > 0) {
    try {
      await enqueueAgentRun(uid, "approved");
      spawnWorkerKick(process.cwd(), uid);
    } catch (e) {
      // The rows are approved either way; the sweep still sends them.
      console.error("[approve-all] could not enqueue the submit run:", e);
    }
  }

  // Board destinations never queue a server-side browser session to click submit.
  return NextResponse.json({
    ok: true,
    approved: matched.length,
    requiresUserSubmit: userSends.length > 0,
    agentWillSend: agentSends.length,
  });
}
