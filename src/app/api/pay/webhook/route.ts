import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { PLANS, type Plan, verifyWebhookSignature } from "@/lib/adapters/payment";

type RzpPaymentEntity = {
  id?: string;
  email?: string;
  notes?: { userId?: string; plan?: string };
};

type RzpEvent = {
  event?: string;
  payload?: {
    payment?: { entity?: RzpPaymentEntity };
    refund?: { entity?: { id?: string; payment_id?: string } };
  };
};

async function grantPlan(uid: string, plan: Plan, paymentId: string) {
  const perDay = PLANS[plan].perDay;

  // Idempotency: skip if already on same plan (webhook may fire after confirm)
  const existing = await prisma.user.findUnique({
    where: { id: uid },
    select: { paid: true, plan: true },
  });
  if (existing?.paid && existing.plan === plan) return;

  await prisma.user.update({
    where: { id: uid },
    data: { paid: true, status: "active", plan },
  });
  await prisma.profile.upsert({
    where: { userId: uid },
    update: { maxPerDay: perDay },
    create: {
      userId: uid,
      maxPerDay: perDay,
      skills: "[]",
      preferredDomains: "[]",
      preferredLocations: "[]",
      excludedCompanies: "[]",
    },
  });
  await audit("payment", { userId: uid, target: paymentId, detail: plan });
}

async function revokePlan(uid: string, refundId: string) {
  await prisma.user.update({
    where: { id: uid },
    data: { paid: false, status: "paused", plan: "starter" },
  });
  await prisma.profile.updateMany({
    where: { userId: uid },
    data: { maxPerDay: 0 },
  });
  await audit("payment_refunded", { userId: uid, target: refundId, detail: "refunded" });
}

export async function POST(req: Request) {
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }

  const sig = req.headers.get("x-razorpay-signature") || "";
  const raw = await req.text();

  if (!verifyWebhookSignature(raw, sig)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: RzpEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  // ── Payment captured ────────────────────────────────────────────────────
  if (event.event === "payment.captured") {
    const payment = event.payload?.payment?.entity ?? {};
    const uid  = payment.notes?.userId;
    const plan: Plan = payment.notes?.plan === "starter" ? "starter" : "pro";
    if (uid) await grantPlan(uid, plan, String(payment.id ?? ""));
  }

  // ── Refund created — downgrade + pause ─────────────────────────────────
  if (event.event === "refund.created") {
    const payment = event.payload?.payment?.entity ?? {};
    const refund  = event.payload?.refund?.entity  ?? {};
    const uid = payment.notes?.userId;

    if (uid) {
      await revokePlan(uid, String(refund.id ?? ""));
    } else if (payment.email) {
      // Fallback: look up by email if notes lacked userId
      const user = await prisma.user.findUnique({
        where: { email: payment.email },
        select: { id: true },
      });
      if (user) await revokePlan(user.id, String(refund.id ?? ""));
    } else {
      console.error("[payment:refund] no userId or email in payload", refund.id);
      await audit("payment_refunded", { target: String(refund.id ?? ""), detail: "no_uid_manual_review" });
    }
  }

  // ── Payment failed ──────────────────────────────────────────────────────
  if (event.event === "payment.failed") {
    const payment = event.payload?.payment?.entity ?? {};
    console.error(`[payment:failed] id=${payment.id}`);
    await audit("payment_failed", { target: String(payment.id ?? ""), detail: "payment_failed" });
  }

  return NextResponse.json({ received: true });
}
