import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockUserFindUnique,
  mockUserCreate,
  mockIssueOtp,
  mockIsRateLimited,
  mockHashPassword,
} = vi.hoisted(() => ({
  mockUserFindUnique: vi.fn(),
  mockUserCreate: vi.fn(),
  mockIssueOtp: vi.fn(),
  mockIsRateLimited: vi.fn(),
  mockHashPassword: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: mockUserFindUnique,
      create: mockUserCreate,
    },
  },
}));
vi.mock("@/lib/auth", () => ({ hashPassword: mockHashPassword }));
vi.mock("@/lib/otp", () => ({
  issueOtp: mockIssueOtp,
  normalizePhone: (p: string) => p,
  maskPhone: (p: string) => `****${p.slice(-4)}`,
  isValidPhone: (p: string) => p.startsWith("+91") && p.length >= 12,
  OtpRateLimitError: class OtpRateLimitError extends Error {
    retryAfterSec = 60;
    constructor(msg: string) { super(msg); this.name = "OtpRateLimitError"; }
  },
}));
vi.mock("@/lib/rateLimit", () => ({
  isRateLimited: mockIsRateLimited,
  getIp: () => "127.0.0.1",
}));
vi.mock("@/lib/proffQuestions", () => ({
  DEFAULTS: {
    preferredDomains: [],
    preferredLocations: [],
    workMode: "any",
    experienceLevel: "fresher",
    stipendMin: 0,
    minMatchScore: 55,
    maxPerDay: 10,
    excludedCompanies: [],
    autoApply: false,
  },
}));

import { POST } from "@/app/api/register/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "127.0.0.1" },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  email: "test@example.com",
  name: "Test User",
  password: "password123",
  phone: "+919876543210",
};

beforeEach(() => {
  vi.resetAllMocks();
  mockIsRateLimited.mockResolvedValue(false);
  mockHashPassword.mockResolvedValue("hashedpw");
  mockUserCreate.mockResolvedValue({});
  mockIssueOtp.mockResolvedValue(undefined);
});

describe("POST /api/register", () => {
  it("returns 400 for invalid email", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, email: "not-an-email" }));
    expect(res.status).toBe(400);
  });

  it("returns 400 for short password (< 6 chars)", async () => {
    const res = await POST(makeReq({ ...VALID_BODY, password: "12345" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/6 characters/i);
  });

  it("returns 429 when IP rate limited", async () => {
    mockIsRateLimited.mockResolvedValue(true);
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(429);
  });

  it("returns 409 for duplicate email", async () => {
    mockUserFindUnique
      .mockResolvedValueOnce({ id: "existing" })
      .mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already exists/i);
  });

  it("returns 409 for duplicate phone", async () => {
    mockUserFindUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "existing" });
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(409);
  });

  it("creates user and issues OTP on success", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.step).toBe("otp");
    expect(mockUserCreate).toHaveBeenCalledOnce();
    expect(mockIssueOtp).toHaveBeenCalledWith("+919876543210");
  });

  it("strips HTML tags from name field (content between tags preserved)", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    // stripHtml strips tags <...> but not content between them
    await POST(makeReq({ ...VALID_BODY, name: "<b>Alice</b>" }));
    expect(mockUserCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Alice" }) })
    );
  });
});
