import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { report } from "@/lib/errors";
import { requireApprovedUser, badRequest, serverError } from "@/lib/auth";
import { PRODUCTS, effectivePlan, isSku } from "@/lib/plans";
import { createOrder } from "@/lib/payment";
import { isRateLimited } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a purchase. Returns what the browser needs to open checkout. */
export async function POST(req: Request) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  // Keyed by USER, not by IP. Checkout is authenticated, so the account is the
  // meaningful bucket — and an IP-keyed limit here would let one person on a
  // shared campus network stop everyone else from paying.
  if (await isRateLimited(`pay:${user.id}`, 15, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many checkout attempts. Try again later." }, { status: 429 });
  }

  let body: { sku?: string; targetId?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const sku = String(body.sku ?? "");
  if (!isSku(sku)) return badRequest("Unknown product.");
  const product = PRODUCTS[sku];

  // A per-target product must name its target at CHECKOUT, validated against
  // the buyer — the grant path applies whatever this order row says and never
  // reads the confirmation request, so this is the one moment the claim
  // "this target is mine to unlock" gets checked.
  let targetId: string | null = null;
  if (product.kind === "target") {
    targetId = String(body.targetId ?? "");
    if (!targetId) return badRequest("Pick the company to unlock first.");
    const target = await prisma.target.findFirst({
      where: { id: targetId, userId: user.id },
      select: { id: true, unlockedAt: true },
    });
    if (!target) return badRequest("That company target does not exist on your account.");
    if (target.unlockedAt) {
      return badRequest("That company is already unlocked on this resume.");
    }
    // A live pass already covers every company. Selling an unlock on top of it
    // is taking money for nothing, so it is refused rather than allowed.
    if (effectivePlan(user) === "pass") {
      return badRequest("Your Season Pass already covers every company.");
    }
  }

  // The order row is created FIRST, carrying the price we decided. The
  // confirmation path then reads the amount and the product off this row rather
  // than off the request — a client that posts `{sku: "pass90", amount: 1}` is
  // sending a number nobody reads.
  let order;
  try {
    order = await prisma.order.create({
      data: {
        userId: user.id,
        sku,
        amount: product.amount,
        currency: product.currency,
        status: "created",
        targetId,
      },
      select: { id: true },
    });
  } catch (e) {
    console.error("[pay] order create failed:", e);
    return serverError("Could not start checkout.");
  }

  let created;
  try {
    created = await createOrder(product, order.id);
  } catch (e) {
    console.error("[pay] provider order failed:", e);
    await prisma.order.update({ where: { id: order.id }, data: { status: "failed" } }).catch(() => null);
    return serverError("The payment provider did not respond. Try again in a moment.");
  }

  // This write is the ONLY link between our order row and the provider's.
  // If it fails and we hand the provider order to the client anyway, the
  // user can pay it, the webhook arrives with a providerOrderId no row
  // carries, and nothing unlocks — money taken, product withheld. So a failed
  // link refuses the checkout (the unpaid provider order is harmless) and
  // says so where the admin will see it.
  try {
    await prisma.order.update({
      where: { id: order.id },
      data: { providerOrderId: created.providerOrderId },
    });
  } catch (e) {
    report({
      source: "web",
      kind: "pay-link-failed",
      message: String(e),
      context: `order:${order.id} provider:${created.providerOrderId}`,
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: "failed" } }).catch(() => null);
    return serverError("We could not start the checkout. You have not been charged — try again in a moment.");
  }

  await audit(user.id, "pay_start", order.id, sku);
  return NextResponse.json({
    ok: true,
    orderId: order.id,
    provider: created.provider,
    providerOrderId: created.providerOrderId,
    amount: created.amount,
    currency: created.currency,
    keyId: created.keyId ?? null,
    product: {
      sku: product.sku,
      name: product.name,
      days: product.kind === "plan" ? product.days : null,
    },
  });
}
