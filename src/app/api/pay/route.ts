import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { PLANS, type Plan } from "@/lib/adapters/payment";
import { sendMessage, onboardingDM } from "@/lib/adapters/slack";

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });
  const { plan } = (await req.json().catch(() => ({}))) as { plan?: Plan };
  const chosen: Plan = plan === "pro" ? "pro" : "starter";
  const perDay = PLANS[chosen]?.perDay ?? 10;

  const user = await prisma.user.update({
    where: { id: uid },
    data: {
      paid: true,
      plan: chosen,
      status: "active",
      profile: { update: { maxPerDay: perDay } },
    },
  });

  if (user.slackChannel || user.slackConnected) {
    await sendMessage({
      channel: user.slackChannel || user.slackUserId || "demo-dm",
      text: onboardingDM(user.name || ""),
    });
  }

  return NextResponse.json({ ok: true });
}
