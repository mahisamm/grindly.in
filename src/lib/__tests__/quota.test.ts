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

  it("uses five successful applications as a lifetime free trial", async () => {
    mockCount.mockResolvedValue(3);
    await expect(getQuota("u1", "free")).resolves.toEqual({
      kind: "trial", cap: PLAN_CAPS.free, used: 3, remaining: 2,
    });
    expect(mockCount).toHaveBeenCalledWith({ where: { userId: "u1", status: "applied" } });
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
