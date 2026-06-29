import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { PLANS, type Plan, verifyPaymentSignature } from "@/lib/adapters/payment";
import { sendMessage, onboardingDM } from "@/lib/adapters/slack";
import { audit } from "@/lib/audit";

/**
 * POST /api/pay/confirm
 *
 * Called by the Razorpay modal success handler with the payment proof.
 * Verifies the HMAC signature before granting the plan.
 *
 * Stub mode (no RAZORPAY_KEY_ID): skips verification and grants plan
 * directly — safe because we still require an active session and only
 * grant to the logged-in user (never a uid from the request body).
 */
export async function POST(req: Request) {
  const sessionUid = await getUid();
  if (!sessionUid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
    plan?: Plan;
    stub?: boolean;
  };

  const plan: Plan = body.plan === "pro" ? "pro" : "starter";

  // Real Razorpay mode — verify signature before any DB write
  if (!body.stub && process.env.RAZORPAY_KEY_ID) {
    if (!body.razorpay_order_id || !body.razorpay_payment_id || !body.razorpay_signature) {
      return NextResponse.json({ error: "missing payment fields" }, { status: 400 });
    }
    const valid = verifyPaymentSignature({
      orderId:   body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });
    if (!valid) {
      return NextResponse.json({ error: "invalid signature" }, { status: 400 });
    }
    await audit("payment", { userId: sessionUid, target: body.razorpay_payment_id, detail: plan });
  }

  const perDay = PLANS[plan].perDay;

  const existing = await prisma.user.findUnique({
    where: { id: sessionUid },
    include: { profile: true },
  });
  if (!existing) return NextResponse.json({ error: "user not found" }, { status: 404 });

  const user = await prisma.user.update({
    where: { id: sessionUid },
    data: {
      paid: true,
      plan,
      status: "active",
      profile: existing.profile
        ? { update: { maxPerDay: perDay } }
        : {
            create: {
              maxPerDay: perDay,
              skills: "[]",
              preferredDomains: "[]",
              preferredLocations: "[]",
              excludedCompanies: "[]",
            },
          },
    },
    include: { profile: true },
  });

  if (user.slackChannel || user.slackConnected) {
    await sendMessage({
      channel: user.slackChannel || user.slackUserId || "demo-dm",
      text: onboardingDM(user.name || ""),
    });
  }

  return NextResponse.json({ ok: true });
}
