/**
 * Payment adapter — Razorpay, stub-ready.
 *
 * Dev/local (no RAZORPAY_KEY_ID): createOrder returns { stub: true }.
 * Frontend skips modal and calls /api/pay/confirm directly.
 *
 * Production: set RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET.
 * Signature verification uses HMAC-SHA256(orderId|paymentId, keySecret).
 */
import crypto from "node:crypto";

// Plan names, prices, and caps live in lib/plans.ts — re-exported here so the
// existing `from "@/lib/adapters/payment"` imports keep working.
export { PLANS, type Plan } from "@/lib/plans";
import { PLANS, type Plan } from "@/lib/plans";

export type OrderResult =
  | { stub: false; orderId: string; keyId: string; amount: number; currency: string; plan: Plan }
  | { stub: true; plan: Plan };

export async function createOrder(opts: { userId: string; plan: Plan }): Promise<OrderResult> {
  const keyId     = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (keyId && keySecret) {
    const amount = PLANS[opts.plan].price * 100; // ₹ → paise
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount,
        currency: "INR",
        receipt: `order_${opts.userId}_${opts.plan}`,
        notes: { userId: opts.userId, plan: opts.plan },
      }),
    });
    if (!res.ok) {
      // Razorpay rejected the order (bad keys, amount, etc.). Surface it instead
      // of returning an order with orderId=undefined, which would hand the
      // checkout modal a broken order and fail silently for the user.
      const detail = await res.text().catch(() => "");
      throw new Error(`Razorpay order failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error("Razorpay order response missing order id");
    }
    return { stub: false, orderId: data.id, keyId, amount, currency: "INR", plan: opts.plan };
  }

  return { stub: true, plan: opts.plan };
}

/** Verify payment signature returned by Razorpay checkout modal. */
export function verifyPaymentSignature(opts: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return false;
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${opts.orderId}|${opts.paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(opts.signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verify Razorpay webhook signature (X-Razorpay-Signature header). */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Read back an order from Razorpay — the authoritative record of what was paid
 * for, and for whom.
 *
 * The confirm route must not take the plan from its request body. The signature
 * only covers orderId|paymentId, so a genuine ₹99 Plus payment could be
 * confirmed with `plan: "pro"` in the JSON and the account would be upgraded to
 * a plan nobody paid for. The order's own notes carry the userId and plan we
 * set at creation, so that is what gets trusted.
 *
 * Returns null when the order cannot be read; the caller must then refuse
 * rather than fall back to the client's claim.
 */
export async function fetchOrder(
  orderId: string,
): Promise<{ userId?: string; plan?: Plan; status?: string; amount?: number } | null> {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !orderId) return null;
  try {
    const res = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(orderId)}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
      },
    });
    if (!res.ok) return null;
    const order = (await res.json()) as {
      status?: string; amount?: number; notes?: { userId?: string; plan?: string };
    };
    const plan = order.notes?.plan;
    return {
      userId: order.notes?.userId,
      plan: plan === "pro" || plan === "plus" ? plan : undefined,
      status: order.status,
      amount: order.amount,
    };
  } catch {
    return null;
  }
}
