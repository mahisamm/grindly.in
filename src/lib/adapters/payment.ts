/**
 * Payment adapter — stubbed, real-ready.
 *
 * Local/dev: `createCheckout` returns an internal success URL immediately so the
 * flow completes without real money. `verify` always succeeds.
 *
 * Production: set STRIPE_SECRET_KEY to swap in a real Stripe Checkout Session.
 * The rest of the app only depends on { url } / { paid } here.
 */

export type Plan = "starter" | "pro";

export const PLANS: Record<Plan, { name: string; price: number; perDay: number; blurb: string }> = {
  starter: { name: "Starter", price: 499, perDay: 10, blurb: "Up to 10 applications/day" },
  pro: { name: "Pro", price: 999, perDay: 30, blurb: "Up to 30 applications/day + priority matching" },
};

export async function createCheckout(opts: {
  userId: string;
  plan: Plan;
  origin: string;
}): Promise<{ url: string; stub: boolean }> {
  const key = process.env.STRIPE_SECRET_KEY;

  if (key) {
    // ---- real Stripe path (test or live depending on key) ----
    const body = new URLSearchParams({
      mode: "payment",
      "line_items[0][price_data][currency]": "inr",
      "line_items[0][price_data][product_data][name]": `InternPilot ${PLANS[opts.plan].name}`,
      "line_items[0][price_data][unit_amount]": String(PLANS[opts.plan].price * 100),
      "line_items[0][quantity]": "1",
      success_url: `${opts.origin}/api/pay/confirm?uid=${opts.userId}&plan=${opts.plan}`,
      cancel_url: `${opts.origin}/onboarding?step=pay`,
      "metadata[userId]": opts.userId,
    });
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    const data = (await res.json()) as { url: string };
    return { url: data.url, stub: false };
  }

  // ---- stub: jump straight to confirm endpoint ----
  return {
    url: `${opts.origin}/api/pay/confirm?uid=${opts.userId}&plan=${opts.plan}&stub=1`,
    stub: true,
  };
}
