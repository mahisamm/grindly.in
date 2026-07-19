import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { dueNow } from "@/lib/pipeline";
import { getQuota } from "@/lib/quota";

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

  const user = await prisma.user.findUnique({ where: { id: uid }, select: { plan: true } });
  if (!user) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const quota = await getQuota(uid, user.plan);
  if (quota.remaining === 0) {
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
    select: { id: true, reason: true },
    take: quota.remaining,
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

  // Safe Apply Mode never queues a server-side browser session to click submit.
  return NextResponse.json({ ok: true, approved: matched.length, requiresUserSubmit: true });
}
