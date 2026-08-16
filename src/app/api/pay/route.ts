import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { PRODUCTS, isSku } from "@/lib/plans";
import { createOrder } from "@/lib/payment";
import { isRateLimited } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Start a purchase. Returns what the browser needs to open checkout. */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  // Keyed by USER, not by IP. Checkout is authenticated, so the account is the
  // meaningful bucket — and an IP-keyed limit here would let one person on a
  // shared campus network stop everyone else from paying.
  if (await isRateLimited(`pay:${user.id}`, 15, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many checkout attempts. Try again later." }, { status: 429 });
  }

  let body: { sku?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const sku = String(body.sku ?? "");
  if (!isSku(sku)) return badRequest("Unknown product.");
  const product = PRODUCTS[sku];

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

  await prisma.order
    .update({ where: { id: order.id }, data: { providerOrderId: created.providerOrderId } })
    .catch(() => null);

  await audit(user.id, "pay_start", order.id, sku);
  return NextResponse.json({
    ok: true,
    orderId: order.id,
    provider: created.provider,
    providerOrderId: created.providerOrderId,
    amount: created.amount,
    currency: created.currency,
    keyId: created.keyId ?? null,
    product: { sku: product.sku, name: product.name, days: product.days },
  });
}
