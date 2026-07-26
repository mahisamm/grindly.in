import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockFindUnique, mockUpdate, mockVerify, mockFetchOrder, mockAudit } =
  vi.hoisted(() => ({
    mockGetUid: vi.fn(), mockFindUnique: vi.fn(), mockUpdate: vi.fn(),
    mockVerify: vi.fn(), mockFetchOrder: vi.fn(), mockAudit: vi.fn(),
  }));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));
vi.mock("@/lib/adapters/slack", () => ({ sendMessage: vi.fn(), onboardingDM: vi.fn() }));
vi.mock("@/lib/adapters/payment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/adapters/payment")>(
    "@/lib/adapters/payment",
  );
  return { ...actual, verifyPaymentSignature: mockVerify, fetchOrder: mockFetchOrder };
});

import { POST } from "@/app/api/pay/confirm/route";

function req(body: Record<string, unknown>) {
  return new Request("http://x/api/pay/confirm", {
    method: "POST", body: JSON.stringify(body),
  });
}

const PAID = {
  razorpay_order_id: "order_1",
  razorpay_payment_id: "pay_1",
  razorpay_signature: "sig",
};

beforeEach(() => {
  vi.resetAllMocks();
  process.env.PAYMENTS_ENABLED = "true";
  process.env.RAZORPAY_KEY_ID = "rzp_test";
  mockGetUid.mockResolvedValue("u1");
  mockVerify.mockReturnValue(true);
  mockFindUnique.mockResolvedValue({ id: "u1", profile: { id: "p1" } });
  mockUpdate.mockResolvedValue({ id: "u1", plan: "plus" });
  mockAudit.mockResolvedValue(undefined);
});

describe("the granted plan comes from the paid order, not the request body", () => {
  it("ignores a body claiming a higher plan than was paid for", async () => {
    // The signature covers orderId|paymentId and nothing else, so a genuine
    // Plus payment could otherwise be confirmed as Pro — an upgrade nobody
    // paid for, granted by the server itself.
    mockFetchOrder.mockResolvedValue({ userId: "u1", plan: "plus", status: "paid" });
    const res = await POST(req({ ...PAID, plan: "pro" }));
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][0].data.plan).toBe("plus");
  });

  it("refuses when the order cannot be read", async () => {
    // Falling back to the client's claim here would reopen the whole hole.
    mockFetchOrder.mockResolvedValue(null);
    expect((await POST(req({ ...PAID, plan: "pro" }))).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses an order belonging to another account", async () => {
    // Otherwise one real payment could be replayed to upgrade someone else.
    mockFetchOrder.mockResolvedValue({ userId: "someone_else", plan: "pro", status: "paid" });
    expect((await POST(req(PAID))).status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses an order that is not actually paid", async () => {
    mockFetchOrder.mockResolvedValue({ userId: "u1", plan: "pro", status: "created" });
    expect((await POST(req(PAID))).status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("grants pro when pro is what was genuinely paid for", async () => {
    mockFetchOrder.mockResolvedValue({ userId: "u1", plan: "pro", status: "paid" });
    const res = await POST(req({ ...PAID, plan: "plus" }));
    expect(res.status).toBe(200);
    expect(mockUpdate.mock.calls[0][0].data.plan).toBe("pro");
  });
});
