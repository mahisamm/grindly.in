import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { dueNow } from "@/lib/pipeline";
import { getQuota, remainingForApproval } from "@/lib/quota";
import { notifyUser } from "@/lib/notify";
import { hasAppAccess } from "@/lib/access";

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
    select: { id: true, reason: true, jobTitle: true, company: true, url: true },
    take: approvable,
  });
  if (matched.length === 0) return NextResponse.json({ ok: true, approved: 0 });

  await prisma.$transaction(
    matched.map((a) =>
      prisma.application.update({
        where: { id: a.id },
        data: { status: "approved", reason: (a.reason ?? "") + " — ready for your final browser submission" },
      })
    )
  );

  // One digest with every link, not one message per job. Best-effort — the
  // approve must succeed even if delivery fails or no channel is configured.
  const lines = matched.map(
    (a) => `• ${a.jobTitle} — ${a.company}${a.url ? `\n  ${a.url}` : ""}`
  );
  void notifyUser(uid, {
    tier: "urgent",
    title: `${matched.length} application${matched.length === 1 ? "" : "s"} ready to submit`,
    body:
      `These are prepared and waiting for your final submit:\n\n${lines.join("\n")}` +
      `\n\nOpen your Grindly dashboard to finish each one.`,
  });

  // Safe Apply Mode never queues a server-side browser session to click submit.
  return NextResponse.json({ ok: true, approved: matched.length, requiresUserSubmit: true });
}
