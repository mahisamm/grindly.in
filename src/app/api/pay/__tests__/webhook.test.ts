import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockUserFindUnique, mockUserUpdate, mockProfileUpsert, mockProfileUpdateMany, mockAuditLogCreate } =
  vi.hoisted(() => ({
    mockUserFindUnique: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockProfileUpsert: vi.fn(),
    mockProfileUpdateMany: vi.fn(),
    mockAuditLogCreate: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
    profile: { upsert: mockProfileUpsert, updateMany: mockProfileUpdateMany },
  },
}));
vi.mock("@/lib/adapters/payment", () => ({
  PLANS: { plus: { perDay: 5 }, pro: { perDay: 15 } },
  verifyWebhookSignature: vi.fn(() => true), // default: valid sig
}));
vi.mock("@/lib/audit", () => ({ audit: mockAuditLogCreate }));

import { POST } from "@/app/api/pay/webhook/route";
import { verifyWebhookSignature } from "@/lib/adapters/payment";

function makeReq(body: unknown, sig = "valid") {
  return new Request("http://localhost/api/pay/webhook", {
    method: "POST",
    headers: { "x-razorpay-signature": sig },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.RAZORPAY_WEBHOOK_SECRET = "wh_secret";
  vi.mocked(verifyWebhookSignature).mockReturnValue(true);
  mockAuditLogCreate.mockResolvedValue({});
  mockUserUpdate.mockResolvedValue({});
  mockProfileUpsert.mockResolvedValue({});
  mockProfileUpdateMany.mockResolvedValue({});
});

describe("POST /api/pay/webhook", () => {
  it("returns 503 when RAZORPAY_WEBHOOK_SECRET not set", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const res = await POST(makeReq({}));
    expect(res.status).toBe(503);
  });

  it("returns 400 on invalid signature", async () => {
    vi.mocked(verifyWebhookSignature).mockReturnValue(false);
    const res = await POST(makeReq({ event: "payment.captured" }));
    expect(res.status).toBe(400);
  });

  describe("payment.captured", () => {
    it("grants plan + sets profile.maxPerDay", async () => {
      mockUserFindUnique.mockResolvedValue({ paid: false, plan: null });

      const event = {
        event: "payment.captured",
        payload: {
          payment: {
            entity: { id: "pay_1", notes: { userId: "u1", plan: "pro" } },
          },
        },
      };
      const res = await POST(makeReq(event));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paid: true, plan: "pro" }) })
      );
      expect(mockProfileUpsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { maxPerDay: 15 } })
      );
    });

    it("skips duplicate event (idempotency)", async () => {
      mockUserFindUnique.mockResolvedValue({ paid: true, plan: "pro" });

      const event = {
        event: "payment.captured",
        payload: { payment: { entity: { id: "pay_1", notes: { userId: "u1", plan: "pro" } } } },
      };
      await POST(makeReq(event));
      expect(mockUserUpdate).not.toHaveBeenCalled();
    });
  });

  describe("refund.created", () => {
    it("revokes plan via notes.userId", async () => {
      const event = {
        event: "refund.created",
        payload: {
          refund:  { entity: { id: "rfnd_1" } },
          payment: { entity: { id: "pay_1", notes: { userId: "u1" } } },
        },
      };
      const res = await POST(makeReq(event));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paid: false, status: "paused" }) })
      );
      expect(mockProfileUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { maxPerDay: 0 } })
      );
    });

    it("falls back to email lookup when no userId in notes", async () => {
      mockUserFindUnique.mockResolvedValue({ id: "u_by_email" });

      const event = {
        event: "refund.created",
        payload: {
          refund:  { entity: { id: "rfnd_2" } },
          payment: { entity: { id: "pay_2", email: "test@example.com", notes: {} } },
        },
      };
      const res = await POST(makeReq(event));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "u_by_email" } })
      );
    });

    it("audits manual review when no uid or email", async () => {
      const event = {
        event: "refund.created",
        payload: {
          refund:  { entity: { id: "rfnd_3" } },
          payment: { entity: { id: "pay_3", notes: {} } },
        },
      };
      const res = await POST(makeReq(event));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        "payment_refunded",
        expect.objectContaining({ detail: "no_uid_manual_review" })
      );
    });
  });

  describe("payment.failed", () => {
    it("audits failure without mutating user", async () => {
      const event = {
        event: "payment.failed",
        payload: { payment: { entity: { id: "pay_fail" } } },
      };
      const res = await POST(makeReq(event));
      expect(res.status).toBe(200);
      expect(mockUserUpdate).not.toHaveBeenCalled();
      expect(mockAuditLogCreate).toHaveBeenCalledWith(
        "payment_failed",
        expect.objectContaining({ target: "pay_fail" })
      );
    });
  });
});
