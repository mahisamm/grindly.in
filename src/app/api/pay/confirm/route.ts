import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, notFound, serverError } from "@/lib/auth";
import { PRODUCTS, effectivePlan, extendedExpiry, isSku } from "@/lib/plans";
import { verifyPayment } from "@/lib/payment";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Confirm a payment and grant the pass.
 *
 * Three properties this endpoint has, each guarding a specific way the naive
 * version gets robbed:
 *
 *   1. The product and price come off the ORDER ROW, never the request. A
 *      client that says "I paid for pass90" is ignored; we look up what they
 *      started checkout for.
 *
 *   2. The signature is verified before anything is granted, and in stub mode
 *      only a stub order id is accepted — so a stub deployment cannot be handed
 *      a fabricated Razorpay payment.
 *
 *   3. Granting is idempotent on the order's status. Replaying a valid
 *      confirmation does not extend the pass a second time; the previous build
 *      had exactly this shape of bug in the other direction, charging a weekly
 *      entitlement twice for one booking.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  let body: {
    orderId?: string;
    razorpay_order_id?: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const orderId = String(body.orderId ?? "");
  if (!orderId) return badRequest("Missing order.");

  const order = await prisma.order.findFirst({
    where: { id: orderId, userId: user.id },
  });
  if (!order) return notFound();

  if (order.status === "paid") {
    // Idempotent replay: report success without granting again.
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { plan: true, planExpiresAt: true },
    });
    return NextResponse.json({ ok: true, alreadyApplied: true, plan: fresh?.plan, expiresAt: fresh?.planExpiresAt });
  }
  if (order.status !== "created") {
    return badRequest("That order can no longer be completed.");
  }

  // The signature must be for THIS order. Without this check the HMAC proves
  // only that *some* payment happened: buy the ₹99 pack once, keep the
  // (order_id, payment_id, signature) triple, then start a ₹399 order and
  // replay the triple here. It validates, and the expensive product is granted,
  // indefinitely. The signature is evidence about the order it names, so the
  // order it names has to be the one being confirmed.
  const claimedOrderId = body.razorpay_order_id || order.providerOrderId || "";
  if (order.providerOrderId && claimedOrderId !== order.providerOrderId) {
    await audit(user.id, "pay_rejected", order.id, "order id mismatch");
    return NextResponse.json({ error: "We could not verify that payment." }, { status: 402 });
  }

  const verified = verifyPayment({
    orderId: claimedOrderId,
    paymentId: body.razorpay_payment_id || `stub_${order.id}`,
    signature: body.razorpay_signature || "",
  });

  if (!verified) {
    // The order is left at `created`, NOT marked failed.
    //
    // Razorpay captures automatically, so a payment may well have gone through
    // even when this particular confirmation could not be verified. The webhook
    // only claims orders in `created`, so flipping this to `failed` permanently
    // blocked the one path that could still grant the plan — leaving the user
    // charged, ungranted, and with no reconciliation anywhere.
    await audit(user.id, "pay_rejected", order.id);
    return NextResponse.json({ error: "We could not verify that payment." }, { status: 402 });
  }

  if (!isSku(order.sku)) {
    console.error("[pay] order carries unknown sku:", order.sku);
    return serverError("That order refers to a product we no longer sell.");
  }
  const product = PRODUCTS[order.sku];

  try {
    await prisma.$transaction(async (tx) => {
      // Re-read inside the transaction and only move `created` -> `paid`. Two
      // concurrent confirmations both passed the check above; only one gets to
      // do this update, and the other's updateMany matches zero rows.
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: "created" },
        data: {
          status: "paid",
          paidAt: new Date(),
          providerPaymentId: body.razorpay_payment_id ?? `stub_${order.id}`,
        },
      });
      if (claimed.count === 0) return;

      const current = await tx.user.findUnique({
        where: { id: user.id },
        select: { plan: true, planExpiresAt: true },
      });
      // Grant what the PRODUCT says it grants. This used to set `plan: "pass"`
      // unconditionally, so the ₹99 single-company pack bought the full ₹399
      // tier for a week.
      //
      // A smaller purchase never downgrades a live larger one: buying a pack
      // while a Season Pass is running extends the pass rather than replacing
      // it with the lesser tier.
      const live = effectivePlan(current ?? {});
      const nextPlan = live === "pass" ? "pass" : product.grants;
      await tx.user.update({
        where: { id: user.id },
        data: {
          plan: nextPlan,
          planExpiresAt: extendedExpiry(current?.planExpiresAt ?? null, product.days),
        },
      });
    });
  } catch (e) {
    console.error("[pay] grant failed:", e);
    return serverError("Your payment went through but we could not apply it. Contact support.");
  }

  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { plan: true, planExpiresAt: true },
  });
  await audit(user.id, "pay_confirmed", order.id, order.sku);
  return NextResponse.json({ ok: true, plan: fresh?.plan, expiresAt: fresh?.planExpiresAt });
}
