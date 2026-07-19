import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { getQuota } from "@/lib/quota";
import { audit } from "@/lib/audit";

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
  if (quota.remaining === 0) {
    return NextResponse.json(
      {
        error: quota.kind === "trial"
          ? "Your free trial is complete. Upgrade to record more applications."
          : "Your daily application limit is reached. Try again tomorrow.",
        code: quota.kind === "trial" ? "trial_exhausted" : "daily_limit_reached",
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
  return NextResponse.json({ ok: true });
}
