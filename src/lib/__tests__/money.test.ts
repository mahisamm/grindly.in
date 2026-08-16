import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * The money and entitlement code, which had no tests at all.
 *
 * These are the functions where a bug is a refund request or a free tier
 * everyone can reach. `verifyPayment` in particular is the single place real
 * money is authenticated, and it was going out untested.
 */

const ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ENV };
});
afterEach(() => {
  process.env = ENV;
});

async function loadPlans() {
  return import("@/lib/plans");
}

// ---------------------------------------------------------------------------
// entitlement
// ---------------------------------------------------------------------------

describe("effectivePlan", () => {
  it("treats an expired pass as free", async () => {
    const { effectivePlan } = await loadPlans();
    expect(
      effectivePlan({ plan: "pass", planExpiresAt: new Date(Date.now() - 1000) }),
    ).toBe("free");
  });

  it("treats a live pass as a pass", async () => {
    const { effectivePlan } = await loadPlans();
    expect(
      effectivePlan({ plan: "pass", planExpiresAt: new Date(Date.now() + 86_400_000) }),
    ).toBe("pass");
  });

  it("refuses a paid plan with no expiry", async () => {
    // A row with plan=pass and a null expiry would otherwise be an unlimited
    // free pass for whoever managed to write it.
    const { effectivePlan } = await loadPlans();
    expect(effectivePlan({ plan: "pass", planExpiresAt: null })).toBe("free");
  });

  it("keeps the single-company pack out of the Season Pass tier", async () => {
    // The ₹99 pack used to grant `pass`, so it bought the entire ₹399 tier for
    // a week while the pricing card said "one company, three rebuilds".
    const { effectivePlan, LIMITS, PRODUCTS } = await loadPlans();
    const live = new Date(Date.now() + 86_400_000);
    expect(effectivePlan({ plan: "pack", planExpiresAt: live })).toBe("pack");
    expect(PRODUCTS.pack1.grants).toBe("pack");
    expect(PRODUCTS.pass90.grants).toBe("pass");
    expect(LIMITS.pack.resumes).toBeLessThan(LIMITS.pass.resumes);
    expect(LIMITS.pack.variantRunsPerDay).toBeLessThan(LIMITS.pass.variantRunsPerDay);
    expect(LIMITS.pack.targetsPerResume).toBeLessThan(LIMITS.pass.targetsPerResume);
  });

  it("gives the free plan strictly less than every paid one", async () => {
    const { LIMITS } = await loadPlans();
    for (const key of ["resumes", "variantRunsPerDay", "targetsPerResume"] as const) {
      expect(LIMITS.free[key]).toBeLessThanOrEqual(LIMITS.pack[key]);
      expect(LIMITS.pack[key]).toBeLessThanOrEqual(LIMITS.pass[key]);
    }
  });
});

describe("extendedExpiry", () => {
  it("extends a live pass rather than replacing it", async () => {
    const { extendedExpiry } = await loadPlans();
    const current = new Date(Date.now() + 10 * 86_400_000);
    const next = extendedExpiry(current, 90);
    // Buying again must never take away time already paid for.
    expect(next.getTime()).toBeGreaterThan(current.getTime());
    expect(Math.round((next.getTime() - current.getTime()) / 86_400_000)).toBe(90);
  });

  it("starts from now when the previous pass has already lapsed", async () => {
    const { extendedExpiry } = await loadPlans();
    const lapsed = new Date(Date.now() - 30 * 86_400_000);
    const next = extendedExpiry(lapsed, 90);
    expect(Math.round((next.getTime() - Date.now()) / 86_400_000)).toBe(90);
  });
});

describe("formatAmount", () => {
  it("renders paise as rupees in the Indian grouping", async () => {
    const { formatAmount } = await loadPlans();
    expect(formatAmount(39900)).toBe("₹399");
    expect(formatAmount(9900)).toBe("₹99");
    expect(formatAmount(150000)).toBe("₹1,500");
  });
});

// ---------------------------------------------------------------------------
// payment verification
// ---------------------------------------------------------------------------

describe("verifyPayment", () => {
  it("in stub mode accepts only a stub order, never a fabricated live one", async () => {
    process.env.PAYMENTS_ENABLED = "false";
    const { verifyPayment } = await import("@/lib/payment");
    expect(verifyPayment({ orderId: "stub_abc", paymentId: "x", signature: "" })).toBe(true);
    // The attack this blocks: posting a plausible Razorpay payment to a
    // deployment that has no Razorpay, and being granted a plan for it.
    expect(verifyPayment({ orderId: "order_LiVe123", paymentId: "pay_1", signature: "deadbeef" }))
      .toBe(false);
  });

  it("verifies a real HMAC when payments are live", async () => {
    process.env.PAYMENTS_ENABLED = "true";
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "shhh";
    const { createHmac } = await import("node:crypto");
    const { verifyPayment } = await import("@/lib/payment");

    const orderId = "order_ABC";
    const paymentId = "pay_XYZ";
    const good = createHmac("sha256", "shhh").update(`${orderId}|${paymentId}`).digest("hex");

    expect(verifyPayment({ orderId, paymentId, signature: good })).toBe(true);
    expect(verifyPayment({ orderId, paymentId, signature: good.replace(/.$/, "0") })).toBe(false);
    expect(verifyPayment({ orderId, paymentId, signature: "" })).toBe(false);
    // A stub id must not be a skeleton key once payments are real.
    expect(verifyPayment({ orderId: "stub_abc", paymentId, signature: good })).toBe(false);
  });

  it("does not throw on a malformed signature", async () => {
    // timingSafeEqual throws on a length mismatch, which would turn a junk
    // signature into a 500 instead of a clean rejection.
    process.env.PAYMENTS_ENABLED = "true";
    process.env.RAZORPAY_KEY_ID = "k";
    process.env.RAZORPAY_KEY_SECRET = "s";
    const { verifyPayment } = await import("@/lib/payment");
    for (const signature of ["", "zz", "not-hex", "a".repeat(3), "ff"]) {
      expect(() => verifyPayment({ orderId: "o", paymentId: "p", signature })).not.toThrow();
      expect(verifyPayment({ orderId: "o", paymentId: "p", signature })).toBe(false);
    }
  });
});

describe("verifyWebhook", () => {
  it("verifies the raw body against the webhook secret", async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "hook-secret";
    const { createHmac } = await import("node:crypto");
    const { verifyWebhook } = await import("@/lib/payment");

    const body = JSON.stringify({ event: "payment.captured" });
    const good = createHmac("sha256", "hook-secret").update(body).digest("hex");

    expect(verifyWebhook(body, good)).toBe(true);
    expect(verifyWebhook(body + " ", good)).toBe(false);
    expect(verifyWebhook(body, "")).toBe(false);
  });

  it("refuses everything when no secret is configured", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const { verifyWebhook } = await import("@/lib/payment");
    expect(verifyWebhook("{}", "anything")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// payments switch
// ---------------------------------------------------------------------------

describe("paymentsEnabled", () => {
  it("needs the explicit switch AND both keys", async () => {
    const cases: [Record<string, string>, boolean][] = [
      [{}, false],
      [{ RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" }, false],
      [{ PAYMENTS_ENABLED: "true" }, false],
      [{ PAYMENTS_ENABLED: "true", RAZORPAY_KEY_ID: "k" }, false],
      [{ PAYMENTS_ENABLED: "1", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" }, false],
      [{ PAYMENTS_ENABLED: "true", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" }, true],
    ];
    for (const [env, expected] of cases) {
      vi.resetModules();
      process.env = { ...ENV };
      delete process.env.PAYMENTS_ENABLED;
      delete process.env.RAZORPAY_KEY_ID;
      delete process.env.RAZORPAY_KEY_SECRET;
      Object.assign(process.env, env);
      const { paymentsEnabled } = await import("@/lib/config");
      expect(paymentsEnabled(), JSON.stringify(env)).toBe(expected);
    }
  });
});
