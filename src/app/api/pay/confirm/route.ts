import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PLANS, type Plan } from "@/lib/adapters/payment";
import { sendMessage, onboardingDM } from "@/lib/adapters/slack";

/** Hit by the (stub or real Stripe) success redirect. Marks user paid, then
 *  fires the Slack onboarding DM via the adapter. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const uid = url.searchParams.get("uid");
  const plan = (url.searchParams.get("plan") as Plan) || "starter";
  if (!uid) return NextResponse.redirect(new URL("/onboarding?step=pay", url.origin));

  const perDay = PLANS[plan]?.perDay ?? 10;
  const user = await prisma.user.update({
    where: { id: uid },
    data: {
      paid: true,
      plan,
      status: "active",
      profile: { update: { maxPerDay: perDay } },
    },
    include: { profile: true },
  });

  // Fire the onboarding DM if Slack is connected (stub logs it regardless).
  if (user.slackChannel || user.slackConnected) {
    await sendMessage({
      channel: user.slackChannel || user.slackUserId || "demo-dm",
      text: onboardingDM(user.name || ""),
    });
  }

  return NextResponse.redirect(new URL("/dashboard?paid=1", url.origin));
}
