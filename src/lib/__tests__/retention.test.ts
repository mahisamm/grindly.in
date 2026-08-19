import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * The retention sweep, whose whole job is deleting rows — so the assertions are
 * about what it does NOT delete.
 */

const { mockAudit, mockError } = vi.hoisted(() => ({
  mockAudit: { deleteMany: vi.fn() },
  mockError: { deleteMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { auditLog: mockAudit, errorEvent: mockError },
}));

import {
  AUDIT_RETENTION_DAYS,
  RESOLVED_ERROR_RETENTION_DAYS,
  cutoff,
  sweepRetention,
} from "@/lib/retention";

beforeEach(() => {
  vi.resetAllMocks();
  mockAudit.deleteMany.mockResolvedValue({ count: 3 });
  mockError.deleteMany.mockResolvedValue({ count: 1 });
});

const NOW = new Date("2026-08-19T12:00:00Z");

describe("cutoff", () => {
  it("is the given number of days before now", () => {
    expect(cutoff(30, NOW).toISOString()).toBe("2026-07-20T12:00:00.000Z");
  });
});

describe("sweepRetention", () => {
  it("deletes audit rows older than the window and nothing newer", async () => {
    await sweepRetention(NOW);
    const where = mockAudit.deleteMany.mock.calls[0][0].where;
    expect(where.createdAt.lt).toEqual(cutoff(AUDIT_RETENTION_DAYS, NOW));
  });

  it("only ever deletes an error that was RESOLVED", async () => {
    // The assertion the table exists for. Age alone must not delete an open
    // error: "this has been broken since March" is exactly what an error table
    // is supposed to still be able to tell you.
    await sweepRetention(NOW);
    const where = mockError.deleteMany.mock.calls[0][0].where;
    expect(where.resolvedAt.not).toBe(null);
    expect(where.resolvedAt.lt).toEqual(cutoff(RESOLVED_ERROR_RETENTION_DAYS, NOW));
  });

  it("keeps a resolved error longer than nothing and shorter than an audit row", () => {
    expect(RESOLVED_ERROR_RETENTION_DAYS).toBeGreaterThan(0);
    expect(RESOLVED_ERROR_RETENTION_DAYS).toBeLessThan(AUDIT_RETENTION_DAYS);
  });

  it("survives a database that is down, and reports what it managed", async () => {
    // Housekeeping runs unawaited off the back of a user's request. A throw
    // here is an unhandled rejection, which Node treats as fatal — it would
    // take the process down to avoid deleting some log rows.
    mockAudit.deleteMany.mockRejectedValue(new Error("db down"));
    const result = await sweepRetention(NOW);
    expect(result.auditLogs).toBe(0);
    expect(result.errorEvents).toBe(1);
  });

  it("sweeps the error table even when the audit sweep failed", async () => {
    mockAudit.deleteMany.mockRejectedValue(new Error("db down"));
    await sweepRetention(NOW);
    expect(mockError.deleteMany).toHaveBeenCalled();
  });
});
