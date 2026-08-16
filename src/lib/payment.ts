/**
 * Checkout: Razorpay when it is fully configured, a local stub otherwise.
 *
 * The stub is the default, and that is a product decision rather than a
 * placeholder. Everything in Grindly works end to end on a fresh clone with no
 * accounts anywhere — including buying a pass, which grants the plan locally
 * without money moving. A product you cannot exercise without a payment gateway
 * is a product nobody evaluates.
 *
 * The switch is `paymentsEnabled()` in config.ts, which requires an explicit
 * PAYMENTS_ENABLED=true AND both keys. Inferring "go live" from the presence of
 * a key is how a staging box takes real money.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, paymentsEnabled } from "@/lib/config";
import type { Product } from "@/lib/plans";

export type CreatedOrder = {
  provider: "razorpay" | "stub";
  providerOrderId: string;
  amount: number;
  currency: string;
  /** Present only for Razorpay — the browser needs it to open Checkout. */
  keyId?: string;
};

export async function createOrder(product: Product, receipt: string): Promise<CreatedOrder> {
  if (!paymentsEnabled()) {
    return {
      provider: "stub",
      providerOrderId: `stub_${receipt}`,
      amount: product.amount,
      currency: product.currency,
    };
  }

  const auth = Buffer.from(`${env("RAZORPAY_KEY_ID")}:${env("RAZORPAY_KEY_SECRET")}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
    body: JSON.stringify({
      amount: product.amount,
      currency: product.currency,
      receipt,
      // Razorpay retries on our behalf when payment capture is automatic; a
      // manual capture would leave successful payments uncaptured if this
      // process died between confirm and capture.
      payment_capture: 1,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Razorpay order failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const order = (await res.json()) as { id: string; amount: number; currency: string };
  return {
    provider: "razorpay",
    providerOrderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: env("RAZORPAY_KEY_ID"),
  };
}

/**
 * Verify a Razorpay checkout callback.
 *
 * The signature is HMAC-SHA256 of `order_id|payment_id` under the key SECRET —
 * never the key ID, which is public and travels to the browser. Comparison is
 * constant-time, because a fast-fail string compare on a signature is a
 * classic, genuinely exploitable timing oracle.
 *
 * In stub mode this returns true for a stub order id and false for anything
 * else — so a client cannot post a fabricated Razorpay payment to a stub
 * deployment and be granted a plan.
 */
export function verifyPayment(params: {
  orderId: string;
  paymentId: string;
  signature: string;
}): boolean {
  if (!paymentsEnabled()) {
    return params.orderId.startsWith("stub_");
  }
  const secret = env("RAZORPAY_KEY_SECRET");
  if (!secret || !params.orderId || !params.paymentId || !params.signature) return false;

  const expected = createHmac("sha256", secret)
    .update(`${params.orderId}|${params.paymentId}`)
    .digest("hex");
  return safeEqualHex(params.signature, expected);
}

/** Verify a webhook body against RAZORPAY_WEBHOOK_SECRET. */
export function verifyWebhook(rawBody: string, signature: string): boolean {
  const secret = env("RAZORPAY_WEBHOOK_SECRET");
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  return safeEqualHex(signature, expected);
}

function safeEqualHex(a: string, b: string): boolean {
  let bufA: Buffer;
  let bufB: Buffer;
  try {
    bufA = Buffer.from(a, "hex");
    bufB = Buffer.from(b, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which would turn a malformed
  // signature into a 500 instead of a rejection.
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
