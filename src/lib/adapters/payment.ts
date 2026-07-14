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

export type Plan = "starter" | "pro";

export const PLANS: Record<Plan, { name: string; price: number; perDay: number; blurb: string }> = {
  starter: { name: "Starter", price: 499, perDay: 10, blurb: "Up to 10 applications/day" },
  pro:     { name: "Pro",     price: 999, perDay: 30, blurb: "Up to 30 applications/day + dedicated support" },
};

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
