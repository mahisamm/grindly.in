import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { getQuota, tryConsumeApplyQuota } from "@/lib/quota";
import { audit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";

/** Records a submission only after the user completed it in their own browser.
 * This endpoint does not contact a job platform or infer that a submission
 * happened; it is an explicit, user-controlled confirmation. */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const app = await prisma.application.findFirst({
    where: { id: body.id, userId: uid, status: "approved" },
    select: { id: true, url: true, jobTitle: true },
  });
  if (!app) return NextResponse.json({ error: "not found or not ready for confirmation" }, { status: 404 });

  const user = await prisma.user.findUnique({ where: { id: uid }, select: { plan: true } });
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const quota = await getQuota(uid, user.plan);

  // Atomic check-and-consume, not read-then-write: a burst of concurrent
  // POSTs for the same user must not all observe "quota available" before any
  // of them commits (see quota.ts tryConsumeApplyQuota — same primitive as
  // rateLimit.ts). NOTE: this counter only tracks flips made through this
  // route; if Safe Apply Mode (agent/safety.py) is ever relaxed to let the
  // Python worker mark an application "applied" directly again, that path
  // needs its own equivalent guard or this one will under-count.
  const consumed = await tryConsumeApplyQuota(uid, quota.cap);
  if (!consumed) {
    return NextResponse.json(
      {
        error: "Your daily application limit is reached. Try again tomorrow.",
        code: "daily_limit_reached",
        quota,
      },
      { status: 402 },
    );
  }

  await prisma.application.update({
    where: { id: app.id },
    data: {
      status: "applied",
      appliedAt: new Date(),
      reason: "Submitted manually by you in your browser (Safe Apply Mode)",
    },
  });
  await audit("manual_submission_confirmed", { userId: uid, target: app.url ?? app.jobTitle });
  // Lands in the in-app feed so there's a persistent record + a nudge to report
  // the outcome later (the interview-rate signal).
  void notifyUser(uid, {
    tier: "digest",
    title: "Application submitted",
    body: `You marked "${app.jobTitle}" as submitted. When you hear back, set the outcome on the Applications tab.`,
  });
  return NextResponse.json({ ok: true });
}
