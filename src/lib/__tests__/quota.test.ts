import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockCount } = vi.hoisted(() => ({ mockCount: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: { application: { count: mockCount } } }));

import { getQuota } from "@/lib/quota";
import { PLAN_CAPS, PLANS } from "@/lib/plans";

beforeEach(() => vi.resetAllMocks());

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
