import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockUserFindUnique,
  mockVerifyPassword,
  mockIssueOtp,
  mockIsRateLimited,
  mockAudit,
} = vi.hoisted(() => ({
  mockUserFindUnique: vi.fn(),
  mockVerifyPassword: vi.fn(),
  mockIssueOtp: vi.fn(),
  mockIsRateLimited: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockUserFindUnique } },
}));
vi.mock("@/lib/auth", () => ({ verifyPassword: mockVerifyPassword }));
vi.mock("@/lib/otp", () => ({
  issueOtp: mockIssueOtp,
  maskPhone: (p: string) => `****${p.slice(-4)}`,
  OtpRateLimitError: class OtpRateLimitError extends Error {
    retryAfterSec = 60;
    constructor(msg: string) { super(msg); this.name = "OtpRateLimitError"; }
  },
}));
vi.mock("@/lib/rateLimit", () => ({
  isRateLimited: mockIsRateLimited,
  getIp: () => "127.0.0.1",
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(() => ({ get: vi.fn(), set: vi.fn() })),
}));

import { POST } from "@/app/api/login/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockIsRateLimited.mockResolvedValue(false);
  mockAudit.mockResolvedValue(undefined);
});

describe("POST /api/login", () => {
  it("returns 400 for invalid input", async () => {
    const res = await POST(makeReq({ email: "not-an-email", password: "x" }));
    expect(res.status).toBe(400);
  });

  it("returns 429 when rate limited", async () => {
    mockIsRateLimited.mockResolvedValue(true);
    const res = await POST(makeReq({ email: "a@b.com", password: "pass" }));
    expect(res.status).toBe(429);
  });

  it("returns 401 for unknown email — same message as wrong password (no enumeration)", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    mockVerifyPassword.mockResolvedValue(false);
    const res = await POST(makeReq({ email: "noone@x.com", password: "wrong" }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/wrong email or password/i);
  });

  it("returns 401 for wrong password", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "u1",
      email: "user@x.com",
      passwordHash: "hash",
      phone: "+919876543210",
      phoneVerified: true,
    });
    mockVerifyPassword.mockResolvedValue(false);
    const res = await POST(makeReq({ email: "user@x.com", password: "wrongpass" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when phone not verified", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "u1",
      email: "user@x.com",
      passwordHash: "hash",
      phone: "+919876543210",
      phoneVerified: false,
    });
    mockVerifyPassword.mockResolvedValue(true);
    const res = await POST(makeReq({ email: "user@x.com", password: "correct" }));
    expect(res.status).toBe(403);
  });

  it("issues OTP and returns 200 on valid credentials", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "u1",
      email: "user@x.com",
      passwordHash: "hash",
      phone: "+919876543210",
      phoneVerified: true,
    });
    mockVerifyPassword.mockResolvedValue(true);
    mockIssueOtp.mockResolvedValue(undefined);

    const res = await POST(makeReq({ email: "user@x.com", password: "correct" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.step).toBe("otp");
    expect(mockIssueOtp).toHaveBeenCalledWith("+919876543210");
  });

  it("returns 429 when OTP rate limit hit during login", async () => {
    mockUserFindUnique.mockResolvedValue({
      id: "u1",
      email: "user@x.com",
      passwordHash: "hash",
      phone: "+919876543210",
      phoneVerified: true,
    });
    mockVerifyPassword.mockResolvedValue(true);
    const { OtpRateLimitError } = await import("@/lib/otp") as any;
    mockIssueOtp.mockRejectedValue(new OtpRateLimitError("too many"));

    const res = await POST(makeReq({ email: "user@x.com", password: "correct" }));
    expect(res.status).toBe(429);
  });
});
