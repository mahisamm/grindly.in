import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid,
  mockUserFindUnique,
  mockUserUpdate,
  mockSendMessage,
  mockVerifyPaymentSignature,
  mockFetchOrder,
  mockAuditLogCreate,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockSendMessage: vi.fn(),
  mockVerifyPaymentSignature: vi.fn(),
  mockFetchOrder: vi.fn(),
  mockAuditLogCreate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockUserFindUnique,
      update: mockUserUpdate,
    },
  },
}));
vi.mock("@/lib/adapters/slack", () => ({
  sendMessage: mockSendMessage,
  onboardingDM: (name: string) => `Welcome ${name}`,
}));
vi.mock("@/lib/adapters/payment", () => ({
  PLANS: {
    plus: { name: "Plus", price: 200, perDay: 5, blurb: "" },
    pro:     { name: "Pro",     price: 999, perDay: 15, blurb: "" },
  },
  verifyPaymentSignature: mockVerifyPaymentSignature,
  // The confirm route now reads the plan back from the PAID order rather than
  // trusting the request body — the signature only covers orderId|paymentId,
  // so a Plus payment could otherwise be confirmed as Pro.
  fetchOrder: mockFetchOrder,
}));
vi.mock("@/lib/audit", () => ({ audit: mockAuditLogCreate }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}));

import { POST } from "@/app/api/pay/confirm/route";

const ORIGIN = "http://localhost:3000";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request(`${ORIGIN}/api/pay/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  // These tests exercise the underlying Razorpay-adapter behavior; the
  // separate business-level "payments are on at all" switch is tested in its
  // own file (see paymentsEnabled.test.ts) and defaults on here so it doesn't
  // shadow what each test is actually asserting.
  process.env.PAYMENTS_ENABLED = "true";
  delete process.env.RAZORPAY_KEY_ID;
  mockSendMessage.mockResolvedValue(undefined);
  mockAuditLogCreate.mockResolvedValue({});
  mockUserUpdate.mockResolvedValue({ id: "u1", slackConnected: false, slackChannel: null, slackUserId: null, name: "Alice" });
});

describe("POST /api/pay/confirm", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(makeReq({ plan: "plus", stub: true }));
    expect(res.status).toBe(401);
  });

  describe("stub mode (no RAZORPAY_KEY_ID)", () => {
    it("grants plan to SESSION user — ignores any body uid", async () => {
      mockGetUid.mockResolvedValue("session_user");
      mockUserFindUnique.mockResolvedValue({ id: "session_user", profile: { id: "p1" } });

      const res = await POST(makeReq({ plan: "pro", stub: true }));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "session_user" } })
      );
    });

    it("grants correct maxPerDay for plus", async () => {
      mockGetUid.mockResolvedValue("u1");
      mockUserFindUnique.mockResolvedValue({ id: "u1", profile: { id: "p1" } });

      await POST(makeReq({ plan: "plus", stub: true }));
      expect(mockUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paid: true, plan: "plus" }),
        })
      );
    });

    it("returns 404 when user not found", async () => {
      mockGetUid.mockResolvedValue("ghost");
      mockUserFindUnique.mockResolvedValue(null);
      const res = await POST(makeReq({ plan: "plus", stub: true }));
      expect(res.status).toBe(404);
    });
  });

  describe("real Razorpay mode (RAZORPAY_KEY_ID set)", () => {
    beforeEach(() => {
      process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    });

    it("returns 400 when payment fields missing", async () => {
      mockGetUid.mockResolvedValue("u1");
      const res = await POST(makeReq({ plan: "plus" }));
      expect(res.status).toBe(400);
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("returns 400 on invalid signature", async () => {
      mockGetUid.mockResolvedValue("u1");
      mockVerifyPaymentSignature.mockReturnValue(false);

      const res = await POST(makeReq({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "badsig",
        plan: "plus",
      }));
      expect(res.status).toBe(400);
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });

    it("grants plan on valid signature", async () => {
      mockGetUid.mockResolvedValue("u1");
      mockVerifyPaymentSignature.mockReturnValue(true);
      // The order is now the authority on WHICH plan was bought; the body's
      // claim is no longer enough on its own.
      mockFetchOrder.mockResolvedValue({ userId: "u1", plan: "pro", status: "paid" });
      mockUserFindUnique.mockResolvedValue({ id: "u1", profile: null });

      const res = await POST(makeReq({
        razorpay_order_id: "order_1",
        razorpay_payment_id: "pay_1",
        razorpay_signature: "validsig",
        plan: "pro",
      }));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paid: true, plan: "pro" }) })
      );
    });

    // Regression: `stub` used to be read from the request body, so a logged-in
    // user could POST {"stub":true,"plan":"pro"} to skip signature verification
    // and grant themselves a paid plan for free. Stub mode is server env only.
    it("ignores a client-supplied stub flag and still demands a signature", async () => {
      mockGetUid.mockResolvedValue("u1");
      mockUserFindUnique.mockResolvedValue({ id: "u1", profile: null });

      const res = await POST(makeReq({ plan: "pro", stub: true }));

      expect(res.status).toBe(400);
      expect(mockVerifyPaymentSignature).not.toHaveBeenCalled();
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });
  });
});
