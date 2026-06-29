import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    otpToken: {
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    otpAttempt: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/adapters/sms", () => ({ sendOtp: vi.fn().mockResolvedValue(undefined) }));

import { verifyOtp, issueOtp, OtpLockedError, OtpRateLimitError } from "@/lib/otp";

const NOW = new Date("2025-01-01T10:00:00Z");
const PHONE = "+919876543210";

beforeEach(() => {
  vi.resetAllMocks();
  vi.setSystemTime(NOW);
  mockPrisma.auditLog.create.mockResolvedValue({});
});

// ─── verifyOtp ────────────────────────────────────────────────────────────

describe("verifyOtp", () => {
  it("returns true for a valid, unexpired OTP", async () => {
    mockPrisma.otpAttempt.findUnique.mockResolvedValue(null);
    mockPrisma.otpToken.findFirst.mockResolvedValue({
      id: "tok1",
      phone: PHONE,
      code: "123456",
      used: false,
      expiresAt: new Date(NOW.getTime() + 5 * 60_000),
      createdAt: NOW,
    });
    mockPrisma.otpAttempt.deleteMany.mockResolvedValue({});
    mockPrisma.otpToken.update.mockResolvedValue({});

    const result = await verifyOtp(PHONE, "123456");
    expect(result).toBe(true);
    expect(mockPrisma.otpToken.update).toHaveBeenCalledWith({
      where: { id: "tok1" },
      data: { used: true },
    });
  });

  it("returns false for wrong OTP code", async () => {
    mockPrisma.otpAttempt.findUnique.mockResolvedValue(null);
    mockPrisma.otpToken.findFirst.mockResolvedValue(null);
    mockPrisma.otpAttempt.upsert.mockResolvedValue({});

    const result = await verifyOtp(PHONE, "000000");
    expect(result).toBe(false);
  });

  it("throws OtpLockedError when locked", async () => {
    const lockedUntil = new Date(NOW.getTime() + 10 * 60_000);
    mockPrisma.otpAttempt.findUnique.mockResolvedValue({
      phone: PHONE,
      attempts: 5,
      lockedUntil,
      windowEnd: lockedUntil,
    });

    await expect(verifyOtp(PHONE, "123456")).rejects.toBeInstanceOf(OtpLockedError);
  });

  it("locks after 5th failed attempt", async () => {
    mockPrisma.otpAttempt.findUnique.mockResolvedValue({
      phone: PHONE,
      attempts: 4,
      lockedUntil: null,
      windowEnd: new Date(NOW.getTime() + 5 * 60_000),
    });
    mockPrisma.otpToken.findFirst.mockResolvedValue(null);
    mockPrisma.otpAttempt.upsert.mockResolvedValue({});

    await expect(verifyOtp(PHONE, "wrong")).rejects.toBeInstanceOf(OtpLockedError);
    expect(mockPrisma.otpAttempt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ lockedUntil: expect.any(Date) }),
      })
    );
  });

  it("resets attempt counter after lockout window expires (stale counter)", async () => {
    mockPrisma.otpAttempt.findUnique.mockResolvedValue({
      phone: PHONE,
      attempts: 5,
      lockedUntil: null,
      windowEnd: new Date(NOW.getTime() - 1),
    });
    mockPrisma.otpToken.findFirst.mockResolvedValue(null);
    mockPrisma.otpAttempt.upsert.mockResolvedValue({});

    const result = await verifyOtp(PHONE, "wrong");
    expect(result).toBe(false);
    // new attempts count must start at 1, not 6
    expect(mockPrisma.otpAttempt.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ attempts: 1 }),
      })
    );
  });
});

// ─── issueOtp ─────────────────────────────────────────────────────────────

describe("issueOtp", () => {
  it("issues OTP when no previous token exists", async () => {
    mockPrisma.otpToken.findFirst.mockResolvedValue(null);
    mockPrisma.otpToken.count.mockResolvedValue(0);
    mockPrisma.otpAttempt.deleteMany.mockResolvedValue({});
    mockPrisma.otpToken.updateMany.mockResolvedValue({});
    mockPrisma.otpToken.create.mockResolvedValue({});

    await expect(issueOtp(PHONE)).resolves.toBeUndefined();
    expect(mockPrisma.otpToken.create).toHaveBeenCalledOnce();
  });

  it("throws OtpRateLimitError when within cooldown (< 60s since last)", async () => {
    mockPrisma.otpToken.findFirst.mockResolvedValue({
      createdAt: new Date(NOW.getTime() - 30_000),
    });

    await expect(issueOtp(PHONE)).rejects.toBeInstanceOf(OtpRateLimitError);
  });

  it("throws OtpRateLimitError when daily cap (5) is reached", async () => {
    mockPrisma.otpToken.findFirst.mockResolvedValue({
      createdAt: new Date(NOW.getTime() - 2 * 60_000),
    });
    mockPrisma.otpToken.count.mockResolvedValue(5);

    await expect(issueOtp(PHONE)).rejects.toBeInstanceOf(OtpRateLimitError);
  });
});
