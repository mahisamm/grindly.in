import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { PRODUCTS, effectivePlan, extendedExpiry, isSku } from "@/lib/plans";
import { verifyWebhook } from "@/lib/payment";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Razorpay's server-to-server notification.
 *
 * This is the path that makes a payment survive the user's browser. Granting
 * used to depend entirely on the browser calling `/api/pay/confirm` after
 * checkout — so closing the tab, losing signal, or any error between Razorpay's
 * capture and our fetch left the user charged (capture is automatic) with an
 * order stuck at `created` forever, and no reconciliation anywhere. The verifier
 * for this existed in `lib/payment.ts` with no caller.
 *
 * Idempotent with `/api/pay/confirm`: whichever arrives first claims the order
 * by moving it `created` → `paid` in a conditional update, and the other one
 * sees zero rows affected and grants nothing. Webhooks redeliver by design.
 */
export async function POST(req: Request) {
  // The RAW body, read before any parsing. The signature covers the exact bytes
  // Razorpay sent; re-serialising a parsed object changes key order and
  // whitespace and the HMAC will never match.
  const raw = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";

  if (!verifyWebhook(raw, signature)) {
    // 401 rather than 400: this is an authentication failure, and Razorpay's
    // dashboard reports it as one so a misconfigured secret is obvious.
    return NextResponse.json({ error: "bad signature" }, { status: 401 });
  }

  let event: {
    event?: string;
    payload?: {
      payment?: {
        entity?: {
          order_id?: string;
          id?: string;
          amount?: number;
          currency?: string;
          status?: string;
        };
      };
    };
  };
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  if (event.event !== "payment.captured") {
    // Acknowledged and ignored. Returning non-200 for events we do not handle
    // makes Razorpay retry them forever.
    return NextResponse.json({ ok: true, ignored: event.event ?? null });
  }

  const entity = event.payload?.payment?.entity ?? {};
  const providerOrderId = entity.order_id;
  if (!providerOrderId) {
    return NextResponse.json({ ok: true, ignored: "no order id" });
  }
  // A captured event can still be a PARTIAL capture. Granting the full product
  // for part of its price is a discount anyone can help themselves to, so the
  // amount and currency are checked against the order rather than assumed.
  if (entity.status && entity.status !== "captured") {
    return NextResponse.json({ ok: true, ignored: `status ${entity.status}` });
  }

  const order = await prisma.order.findUnique({ where: { providerOrderId } });
  if (!order) {
    // Not ours, or from another environment sharing the account. Acknowledge.
    return NextResponse.json({ ok: true, ignored: "unknown order" });
  }
  if (!isSku(order.sku)) {
    console.error("[webhook] order carries unknown sku:", order.sku);
    return NextResponse.json({ ok: true, ignored: "unknown sku" });
  }
  const product = PRODUCTS[order.sku];

  // Underpayment must never grant. Acknowledged (200) so Razorpay stops
  // retrying, but nothing is granted and it is logged loudly for a human.
  if (typeof entity.amount === "number" && entity.amount < order.amount) {
    console.error(
      `[webhook] underpayment on ${order.id}: paid ${entity.amount}, owed ${order.amount}`,
    );
    await audit(order.userId, "pay_underpaid", order.id, String(entity.amount));
    return NextResponse.json({ ok: true, ignored: "amount below order" });
  }
  if (entity.currency && entity.currency !== order.currency) {
    console.error(`[webhook] currency mismatch on ${order.id}: ${entity.currency}`);
    return NextResponse.json({ ok: true, ignored: "currency mismatch" });
  }

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: "created" },
        data: {
          status: "paid",
          paidAt: new Date(),
          providerPaymentId: entity.id ?? null,
        },
      });
      // Already granted by /api/pay/confirm, or by an earlier delivery of this
      // same webhook. Nothing to do — and crucially, no second grant.
      if (claimed.count === 0) return;

      const current = await tx.user.findUnique({
        where: { id: order.userId },
        select: { plan: true, planExpiresAt: true },
      });
      const live = effectivePlan(current ?? {});
      await tx.user.update({
        where: { id: order.userId },
        data: {
          plan: live === "pass" ? "pass" : product.grants,
          planExpiresAt: extendedExpiry(current?.planExpiresAt ?? null, product.days),
        },
      });
      await audit(order.userId, "pay_webhook", order.id, order.sku);
    });
  } catch (e) {
    console.error("[webhook] grant failed:", e);
    // 500 so Razorpay retries. The claim is conditional, so a retry after a
    // partial failure cannot double-grant.
    return NextResponse.json({ error: "grant failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
