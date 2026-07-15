import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockCreateOrder } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockCreateOrder: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/adapters/payment", () => ({
  createOrder: mockCreateOrder,
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}));

import { POST } from "@/app/api/pay/route";

function makeReq(body: unknown = {}) {
  return new Request("http://localhost/api/pay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("POST /api/pay", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(makeReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/no session/i);
  });

  it("calls createOrder with plus plan by default", async () => {
    mockGetUid.mockResolvedValue("user_1");
    mockCreateOrder.mockResolvedValue({ stub: true, plan: "plus" });

    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", plan: "plus" })
    );
  });

  it("calls createOrder with pro plan when specified", async () => {
    mockGetUid.mockResolvedValue("user_1");
    mockCreateOrder.mockResolvedValue({ stub: true, plan: "pro" });

    await POST(makeReq({ plan: "pro" }));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "pro" })
    );
  });

  it("defaults to plus for unknown plan value", async () => {
    mockGetUid.mockResolvedValue("user_1");
    mockCreateOrder.mockResolvedValue({ stub: true, plan: "plus" });

    await POST(makeReq({ plan: "enterprise" }));
    expect(mockCreateOrder).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "plus" })
    );
  });

  it("returns stub:true when no Razorpay key", async () => {
    mockGetUid.mockResolvedValue("user_1");
    mockCreateOrder.mockResolvedValue({ stub: true, plan: "plus" });

    const res = await POST(makeReq({ plan: "plus" }));
    const body = await res.json();
    expect(body.stub).toBe(true);
  });

  it("returns orderId + keyId in real mode", async () => {
    mockGetUid.mockResolvedValue("user_1");
    mockCreateOrder.mockResolvedValue({
      stub: false,
      orderId: "order_abc",
      keyId: "rzp_test_key",
      amount: 49900,
      currency: "INR",
      plan: "plus",
    });

    const res = await POST(makeReq({ plan: "plus" }));
    const body = await res.json();
    expect(body.orderId).toBe("order_abc");
    expect(body.keyId).toBe("rzp_test_key");
  });
});
