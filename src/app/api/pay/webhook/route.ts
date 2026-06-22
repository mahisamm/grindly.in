import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";

/**
 * Stripe webhook — the trustworthy source of "payment succeeded". Verifies the
 * `Stripe-Signature` HMAC against STRIPE_WEBHOOK_SECRET before acting, so a
 * forged request can't flip a user to paid. On checkout.session.completed it
 * marks the user paid + active with the purchased plan.
 */
function verifySignature(payload: string, header: string, secret: string): boolean {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => kv.split("=") as [string, string])
  );
  const t = parts["t"];
  const v1 = parts["v1"];
  if (!t || !v1) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "webhook not configured" }, { status: 503 });
  }
  const sig = req.headers.get("stripe-signature") || "";
  const raw = await req.text();

  if (!verifySignature(raw, sig, secret)) {
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: { type?: string; data?: { object?: Record<string, unknown> } };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }

  if (event.type === "checkout.session.completed") {
    const obj = event.data?.object ?? {};
    const meta = (obj.metadata ?? {}) as { userId?: string; plan?: string };
    const uid = meta.userId;
    const plan = meta.plan === "starter" ? "starter" : "pro";
    if (uid) {
      await prisma.user.update({
        where: { id: uid },
        data: { paid: true, status: "active", plan },
      });
      await audit("payment", { userId: uid, target: String(obj.id ?? ""), detail: plan });
    }
  }

  return NextResponse.json({ received: true });
}
