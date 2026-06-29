import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockVerifyOtp, mockSetUid, mockUserFindUnique, mockUserUpdate } = vi.hoisted(() => ({
  mockVerifyOtp: vi.fn(),
  mockSetUid: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUserUpdate: vi.fn(),
}));

vi.mock("@/lib/otp", () => ({
  verifyOtp: mockVerifyOtp,
  normalizePhone: (p: string) => p,
  OtpLockedError: class OtpLockedError extends Error {
    retryAfterSec = 900;
    constructor() { super("locked"); this.name = "OtpLockedError"; }
  },
}));
vi.mock("@/lib/session", () => ({ setUid: mockSetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
  },
}));
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() })),
}));

import { POST } from "@/app/api/auth/verify-otp/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/auth/verify-otp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => vi.resetAllMocks());

describe("POST /api/auth/verify-otp", () => {
  it("returns 400 for missing fields", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 for short code", async () => {
    const res = await POST(makeReq({ phone: "+919876543210", code: "123" }));
    expect(res.status).toBe(400);
  });

  it("returns 401 for invalid OTP", async () => {
    mockVerifyOtp.mockResolvedValue(false);
    const res = await POST(makeReq({ phone: "+919876543210", code: "000000" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/i);
  });

  it("returns 404 when user not found after valid OTP", async () => {
    mockVerifyOtp.mockResolvedValue(true);
    mockUserFindUnique.mockResolvedValue(null);
    const res = await POST(makeReq({ phone: "+919876543210", code: "123456" }));
    expect(res.status).toBe(404);
  });

  it("returns 429 when OTP is locked", async () => {
    const { OtpLockedError } = await import("@/lib/otp") as any;
    mockVerifyOtp.mockRejectedValue(new OtpLockedError());
    const res = await POST(makeReq({ phone: "+919876543210", code: "999999" }));
    expect(res.status).toBe(429);
  });

  it("returns 200 and sets session for valid OTP", async () => {
    mockVerifyOtp.mockResolvedValue(true);
    mockSetUid.mockResolvedValue(undefined);
    mockUserFindUnique.mockResolvedValue({
      id: "user_1",
      phone: "+919876543210",
      phoneVerified: true,
      status: "active",
    });

    const res = await POST(makeReq({ phone: "+919876543210", code: "123456" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.userId).toBe("user_1");
    expect(mockSetUid).toHaveBeenCalledWith("user_1");
  });

  it("marks phone verified when not already verified", async () => {
    mockVerifyOtp.mockResolvedValue(true);
    mockSetUid.mockResolvedValue(undefined);
    mockUserFindUnique.mockResolvedValue({
      id: "user_2",
      phone: "+919876543210",
      phoneVerified: false,
      status: "onboarding",
    });
    mockUserUpdate.mockResolvedValue({});

    await POST(makeReq({ phone: "+919876543210", code: "123456" }));
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "user_2" },
      data: { phoneVerified: true },
    });
  });
});
