import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Covers the business-level "are payments on at all" switch (PAYMENTS_ENABLED),
// which is separate from — and checked before — the Razorpay-key-presence
// inference the rest of confirm.test.ts / route.test.ts exercise. Without this
// switch, the onboarding "coming soon" paid-plan button was only ever disabled
// client-side by `busy || !tosAck`, so a real checkout could still run the
// moment Razorpay keys happened to exist in a non-strict-production env.

const { mockGetUid, mockCreateOrder, mockVerifyPaymentSignature } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockCreateOrder: vi.fn(),
  mockVerifyPaymentSignature: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/adapters/payment", () => ({
  createOrder: mockCreateOrder,
  verifyPaymentSignature: mockVerifyPaymentSignature,
  PLANS: {
    plus: { name: "Plus", price: 200, perDay: 5, blurb: "" },
    pro: { name: "Pro", price: 999, perDay: 15, blurb: "" },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: vi.fn(), update: vi.fn() } } }));
vi.mock("@/lib/adapters/slack", () => ({ sendMessage: vi.fn(), onboardingDM: () => "" }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })) }));

import { POST as payPOST } from "@/app/api/pay/route";
import { POST as confirmPOST } from "@/app/api/pay/confirm/route";

function makeReq(url: string, body: unknown = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ORIGINAL_PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED;

beforeEach(() => {
  vi.resetAllMocks();
  mockGetUid.mockResolvedValue("user_1");
});

afterEach(() => {
  if (ORIGINAL_PAYMENTS_ENABLED === undefined) delete process.env.PAYMENTS_ENABLED;
  else process.env.PAYMENTS_ENABLED = ORIGINAL_PAYMENTS_ENABLED;
});

describe("PAYMENTS_ENABLED gate", () => {
  it("/api/pay returns 503 when PAYMENTS_ENABLED is unset, even with no other blockers", async () => {
    delete process.env.PAYMENTS_ENABLED;
    const res = await payPOST(makeReq("http://localhost/api/pay", { plan: "plus" }));
    expect(res.status).toBe(503);
    expect(mockCreateOrder).not.toHaveBeenCalled();
  });

  it('/api/pay returns 503 when PAYMENTS_ENABLED is any value other than "true"', async () => {
    process.env.PAYMENTS_ENABLED = "1";
    const res = await payPOST(makeReq("http://localhost/api/pay", { plan: "plus" }));
    expect(res.status).toBe(503);
  });

  it("/api/pay proceeds to createOrder once PAYMENTS_ENABLED=true", async () => {
    process.env.PAYMENTS_ENABLED = "true";
    mockCreateOrder.mockResolvedValue({ stub: true, plan: "plus" });
    const res = await payPOST(makeReq("http://localhost/api/pay", { plan: "plus" }));
    expect(res.status).toBe(200);
    expect(mockCreateOrder).toHaveBeenCalled();
  });

  it("/api/pay/confirm returns 503 when PAYMENTS_ENABLED is unset, before any signature check", async () => {
    delete process.env.PAYMENTS_ENABLED;
    const res = await confirmPOST(makeReq("http://localhost/api/pay/confirm", { plan: "plus", stub: true }));
    expect(res.status).toBe(503);
    expect(mockVerifyPaymentSignature).not.toHaveBeenCalled();
  });
});
