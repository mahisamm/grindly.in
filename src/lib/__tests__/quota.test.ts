import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCount, mockProfileFind, mockRateFindUnique, mockRateUpsert, mockRateUpdate } = vi.hoisted(() => ({
  mockCount: vi.fn(),
  mockProfileFind: vi.fn(),
  mockRateFindUnique: vi.fn(),
  mockRateUpsert: vi.fn(),
  mockRateUpdate: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    application: { count: mockCount },
    profile: { findUnique: mockProfileFind },
    rateLimitEntry: { findUnique: mockRateFindUnique, upsert: mockRateUpsert, update: mockRateUpdate },
  },
}));

import { getQuota, pendingApprovedCount, remainingForApproval, tryConsumeApplyQuota } from "@/lib/quota";
import { PLAN_CAPS, PLANS } from "@/lib/plans";

beforeEach(() => {
  vi.resetAllMocks();
  // Day boundaries come from the user's profile timezone now.
  mockProfileFind.mockResolvedValue({ timezone: "Asia/Kolkata" });
});

describe("application quotas", () => {
  it("defines the requested paid plan limits", () => {
    expect(PLANS.plus.perDay).toBe(5);
    expect(PLANS.pro.perDay).toBe(15);
  });

  it("treats free as a daily plan (5/day) during the free beta", async () => {
    mockCount.mockResolvedValue(3);
    const quota = await getQuota("u1", "free");
    expect(quota).toEqual({ kind: "daily", cap: PLAN_CAPS.free, used: 3, remaining: 2 });
    // daily → counts today's applications (appliedAt filter), not lifetime total.
    expect(mockCount.mock.calls[0][0].where.appliedAt.gte).toBeInstanceOf(Date);
  });

  it("uses appliedAt for paid daily limits", async () => {
    mockCount.mockResolvedValue(4);
    const quota = await getQuota("u1", "pro");
    expect(quota).toEqual({ kind: "daily", cap: 15, used: 4, remaining: 11 });
    expect(mockCount.mock.calls[0][0].where.appliedAt.gte).toBeInstanceOf(Date);
  });

  it("never returns a negative remaining quota", async () => {
    mockCount.mockResolvedValue(99);
    expect((await getQuota("u1", "plus")).remaining).toBe(0);
  });
});

describe("pendingApprovedCount / remainingForApproval (approval-accumulation guard)", () => {
  it("subtracts already-approved-but-unsubmitted rows from today's remaining cap", async () => {
    // getQuota() -> applied-today count
    mockCount.mockResolvedValueOnce(1);
    // pendingApprovedCount() -> approved-and-waiting count
    mockCount.mockResolvedValueOnce(2);
    const approvable = await remainingForApproval("u1", "plus"); // cap 5
    expect(approvable).toBe(2); // 5 - 1 applied - 2 pending = 2
  });

  it("floors at zero instead of going negative when the backlog exceeds the cap", async () => {
    mockCount.mockResolvedValueOnce(0); // applied today
    mockCount.mockResolvedValueOnce(50); // huge accumulated backlog
    expect(await remainingForApproval("u1", "free")).toBe(0);
  });

  it("counts only rows approved TODAY, so the reservation expires with its day", async () => {
    // Counting every approved row for all time bricked the product: almost
    // nobody ticks "yes, I submitted it", so after one day of approvals the
    // pending count permanently equalled the cap and the user could never
    // approve again — told to "try again tomorrow" on every tomorrow.
    mockCount.mockResolvedValueOnce(7);
    await pendingApprovedCount("u1");
    const arg = mockCount.mock.calls[0][0];
    expect(arg.where.userId).toBe("u1");
    expect(arg.where.status).toBe("approved");
    expect(arg.where.approvedAt.gte).toBeInstanceOf(Date);
    // The boundary is the start of today, not "24h ago".
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    expect(arg.where.approvedAt.gte.getTime()).toBe(start.getTime());
  });
});

describe("tryConsumeApplyQuota (atomic check-and-consume)", () => {
  it("consumes and allows when under cap (increment path)", async () => {
    mockRateFindUnique.mockResolvedValue({ key: "k", count: 2, windowEnd: new Date(Date.now() + 1000) });
    mockRateUpdate.mockResolvedValue({ count: 3 });
    const ok = await tryConsumeApplyQuota("u1", 5);
    expect(ok).toBe(true);
    expect(mockRateUpdate).toHaveBeenCalled();
  });

  it("blocks once the atomic counter reaches cap", async () => {
    mockRateFindUnique.mockResolvedValue({ key: "k", count: 5, windowEnd: new Date(Date.now() + 1000) });
    mockRateUpdate.mockResolvedValue({ count: 6 });
    const ok = await tryConsumeApplyQuota("u1", 5);
    expect(ok).toBe(false);
  });

  it("rejects a non-positive cap without touching the DB", async () => {
    const ok = await tryConsumeApplyQuota("u1", 0);
    expect(ok).toBe(false);
    expect(mockRateFindUnique).not.toHaveBeenCalled();
  });
});
