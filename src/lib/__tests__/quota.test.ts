import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The daily-ceiling logic, which had no tests.
 *
 * The property that matters is the rollback: a refused reservation must not
 * consume the allowance it was refused for. Without it, a user who hits the cap
 * at 10am keeps incrementing the counter with every retry and can never use the
 * product again, even after the window they were told to wait for.
 */

const { mockUser, mockUsage } = vi.hoisted(() => ({
  mockUser: { findUnique: vi.fn() },
  mockUsage: { upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockUser, dailyUsage: mockUsage },
}));

import { localDate, refund, reserve, usageToday } from "@/lib/quota";

beforeEach(() => {
  vi.resetAllMocks();
  mockUser.findUnique.mockResolvedValue({ plan: "free", planExpiresAt: null });
  mockUsage.update.mockResolvedValue({});
  mockUsage.updateMany.mockResolvedValue({ count: 1 });
});

describe("localDate", () => {
  it("returns an ISO date in the user's zone, not UTC", () => {
    // 18:45 UTC on the 5th is already the 6th in Kolkata (+05:30).
    const at = new Date("2026-03-05T18:45:00Z");
    expect(localDate("Asia/Kolkata", at)).toBe("2026-03-06");
    expect(localDate("UTC", at)).toBe("2026-03-05");
  });

  it("falls back to UTC for a nonsense timezone rather than throwing", () => {
    // A tampered profile must not be able to 500 every quota check.
    expect(() => localDate("Not/AZone", new Date("2026-03-05T18:45:00Z"))).not.toThrow();
    expect(localDate("Not/AZone", new Date("2026-03-05T18:45:00Z"))).toBe("2026-03-05");
  });
});

describe("reserve", () => {
  it("allows a request inside the limit and reports what is left", async () => {
    mockUsage.upsert.mockResolvedValue({ variantRuns: 1 });
    const verdict = await reserve("u1", "variantRuns");
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.used).toBe(1);
      expect(verdict.limit).toBe(2); // free plan
      expect(verdict.remaining).toBe(1);
    }
    expect(mockUsage.update).not.toHaveBeenCalled();
  });

  it("refuses past the limit AND hands the reserved unit back", async () => {
    // The rollback is the whole point: without it every refused retry burns
    // another unit and the counter climbs forever.
    mockUsage.upsert.mockResolvedValue({ variantRuns: 3 });
    const verdict = await reserve("u1", "variantRuns");
    expect(verdict.allowed).toBe(false);
    expect(mockUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { variantRuns: { decrement: 1 } } }),
    );
  });

  it("reserves atomically — one increment, one round trip", async () => {
    mockUsage.upsert.mockResolvedValue({ variantRuns: 1 });
    await reserve("u1", "variantRuns");
    expect(mockUsage.upsert).toHaveBeenCalledTimes(1);
    const call = mockUsage.upsert.mock.calls[0][0];
    // A read-then-write would let concurrent requests both see the same count
    // and both proceed.
    expect(call.update).toEqual({ variantRuns: { increment: 1 } });
  });

  it("gives a paid plan its larger ceiling", async () => {
    mockUser.findUnique.mockResolvedValue({
      plan: "pass",
      planExpiresAt: new Date(Date.now() + 86_400_000),
    });
    mockUsage.upsert.mockResolvedValue({ variantRuns: 10 });
    const verdict = await reserve("u1", "variantRuns");
    expect(verdict.allowed).toBe(true);
    expect(verdict.limit).toBe(40);
  });

  it("refuses a user that does not exist", async () => {
    mockUser.findUnique.mockResolvedValue(null);
    const verdict = await reserve("ghost", "variantRuns");
    expect(verdict.allowed).toBe(false);
    expect(mockUsage.upsert).not.toHaveBeenCalled();
  });

  it("keys the row by user AND local date", async () => {
    mockUsage.upsert.mockResolvedValue({ uploads: 1 });
    await reserve("u1", "uploads", "UTC");
    const where = mockUsage.upsert.mock.calls[0][0].where;
    expect(where.userId_localDate.userId).toBe("u1");
    expect(where.userId_localDate.localDate).toBe(localDate("UTC"));
  });
});

describe("refund", () => {
  it("never drives a counter below zero", async () => {
    await refund("u1", "variantRuns");
    const where = mockUsage.updateMany.mock.calls[0][0].where;
    expect(where.variantRuns).toEqual({ gt: 0 });
  });

  it("swallows a database error rather than failing the request it is cleaning up after", async () => {
    mockUsage.updateMany.mockRejectedValue(new Error("db down"));
    await expect(refund("u1", "variantRuns")).resolves.toBeUndefined();
  });
});

describe("usageToday", () => {
  it("reports every meter and never mutates", async () => {
    mockUsage.findUnique.mockResolvedValue({ variantRuns: 1, adviceRuns: 0, uploads: 2 });
    const usage = await usageToday("u1");
    expect(usage.variantRuns).toEqual({ used: 1, limit: 2 });
    expect(usage.adviceRuns).toEqual({ used: 0, limit: 3 });
    expect(usage.uploads).toEqual({ used: 2, limit: 5 });
    expect(mockUsage.upsert).not.toHaveBeenCalled();
    expect(mockUsage.update).not.toHaveBeenCalled();
  });

  it("reports zeroes when there is no row yet", async () => {
    mockUsage.findUnique.mockResolvedValue(null);
    const usage = await usageToday("u1");
    expect(usage.variantRuns.used).toBe(0);
  });
});
