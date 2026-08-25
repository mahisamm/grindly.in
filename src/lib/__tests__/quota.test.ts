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
  mockUsage: {
    upsert: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(),
    aggregate: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: mockUser, dailyUsage: mockUsage },
}));

import {
  DEFAULT_TIMEZONE, isValidTimezone, localDate, refund, reserve, usageToday,
} from "@/lib/quota";

beforeEach(() => {
  vi.resetAllMocks();
  mockUser.findUnique.mockResolvedValue({ plan: "free", planExpiresAt: null });
  mockUsage.update.mockResolvedValue({});
  mockUsage.updateMany.mockResolvedValue({ count: 1 });
  // Lifetime sums (the free plan's window) default to "today's row is all
  // there is", so single-day tests read the same as before the pivot.
  mockUsage.aggregate.mockImplementation(() =>
    Promise.resolve({ _sum: { variantRuns: null, adviceRuns: null } }),
  );
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
    mockUsage.aggregate.mockResolvedValue({ _sum: { variantRuns: 1 } });
    const verdict = await reserve("u1", "variantRuns");
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.used).toBe(1);
      expect(verdict.limit).toBe(2); // free plan, lifetime
      expect(verdict.remaining).toBe(1);
    }
    expect(mockUsage.update).not.toHaveBeenCalled();
  });

  it("counts a free account's rebuilds across its LIFETIME, not its day", async () => {
    // The daily reset taught patient users to wait for midnight and never
    // pay. Today's row says 1, but history says 3 — the request is refused
    // and the message must not promise a midnight reset that will not help.
    mockUsage.upsert.mockResolvedValue({ variantRuns: 1 });
    mockUsage.aggregate.mockResolvedValue({ _sum: { variantRuns: 4 } });
    const verdict = await reserve("u1", "variantRuns");
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.message).not.toContain("midnight");
      expect(verdict.message).toContain("in total");
    }
    // The refused unit is still handed back to today's row.
    expect(mockUsage.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { variantRuns: { decrement: 1 } } }),
    );
  });

  it("keeps UPLOADS daily even for free accounts", async () => {
    // Uploads cost local parsing, not provider quota; a lifetime cap there
    // would strand someone iterating on their file.
    mockUsage.upsert.mockResolvedValue({ uploads: 2 });
    const verdict = await reserve("u1", "uploads");
    expect(verdict.allowed).toBe(true);
    expect(mockUsage.aggregate).not.toHaveBeenCalled();
  });

  it("refuses past the limit AND hands the reserved unit back", async () => {
    // The rollback is the whole point: without it every refused retry burns
    // another unit and the counter climbs forever.
    mockUsage.upsert.mockResolvedValue({ variantRuns: 4 });
    mockUsage.aggregate.mockResolvedValue({ _sum: { variantRuns: 4 } });
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
    mockUser.findUnique.mockResolvedValue({ plan: "free", timezone: "UTC" });
    mockUsage.upsert.mockResolvedValue({ uploads: 1 });
    await reserve("u1", "uploads");
    const where = mockUsage.upsert.mock.calls[0][0].where;
    expect(where.userId_localDate.userId).toBe("u1");
    expect(where.userId_localDate.localDate).toBe(localDate("UTC"));
  });

  // The regression this file exists to prevent from coming back. Every function
  // in quota.ts used to take `timezone = "Asia/Kolkata"` and no caller passed
  // it, so a user in Los Angeles had their day roll over at 10:30 the previous
  // morning while the refusal told them it resets at their midnight.
  it("counts in the user's OWN day, not the server's default", async () => {
    mockUser.findUnique.mockResolvedValue({ plan: "free", timezone: "America/Los_Angeles" });
    mockUsage.upsert.mockResolvedValue({ uploads: 1 });
    await reserve("u1", "uploads");
    const key = mockUsage.upsert.mock.calls[0][0].where.userId_localDate.localDate;
    expect(key).toBe(localDate("America/Los_Angeles"));
  });

  it("falls back to the default zone for an account that has not told us", async () => {
    mockUser.findUnique.mockResolvedValue({ plan: "free", timezone: null });
    mockUsage.upsert.mockResolvedValue({ uploads: 1 });
    await reserve("u1", "uploads");
    const key = mockUsage.upsert.mock.calls[0][0].where.userId_localDate.localDate;
    expect(key).toBe(localDate(DEFAULT_TIMEZONE));
  });
});

describe("isValidTimezone", () => {
  it("accepts what a browser actually reports", () => {
    for (const zone of ["Asia/Kolkata", "America/Los_Angeles", "UTC", "Europe/London"]) {
      expect(isValidTimezone(zone), zone).toBe(true);
    }
  });

  it("rejects anything the runtime cannot use", () => {
    // Each of these would be stored happily by a regex check and would then
    // throw on every quota call for that one account.
    expect(isValidTimezone("Nonsense/Nowhere")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(42)).toBe(false);
    expect(isValidTimezone("A".repeat(200))).toBe(false);
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
    mockUsage.aggregate.mockResolvedValue({ _sum: { variantRuns: 1, adviceRuns: 0 } });
    const usage = await usageToday("u1");
    // Free plan: the model-priced meters report their LIFETIME window.
    expect(usage.variantRuns).toEqual({ used: 1, limit: 2, lifetime: true });
    expect(usage.adviceRuns).toEqual({ used: 0, limit: 3, lifetime: true });
    expect(usage.uploads).toEqual({ used: 2, limit: 5, lifetime: false });
    expect(mockUsage.upsert).not.toHaveBeenCalled();
    expect(mockUsage.update).not.toHaveBeenCalled();
  });

  it("reports zeroes when there is no row yet", async () => {
    mockUsage.findUnique.mockResolvedValue(null);
    const usage = await usageToday("u1");
    expect(usage.variantRuns.used).toBe(0);
  });
});
