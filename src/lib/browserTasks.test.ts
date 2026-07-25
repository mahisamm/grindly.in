import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst, mockUpdateMany } = vi.hoisted(() => ({
  mockFindFirst: vi.fn(),
  mockUpdateMany: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: { browserTask: { findFirst: mockFindFirst, updateMany: mockUpdateMany } },
}));

import { claimNextTask, ownsTask, hashLease, reclaimExpiredTasks, LEASE_MS } from "./browserTasks";

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("lease reclaim", () => {
  it("only reclaims states that cannot have submitted", async () => {
    await reclaimExpiredTasks();
    const where = mockUpdateMany.mock.calls[0][0].where;
    // A submitted task must never come back: re-running it sends the employer a
    // second application. awaiting_human holds no lease and is waiting on the
    // person, so reclaiming it would nag them mid-CAPTCHA.
    expect(where.state.in).toEqual(["leased", "filling"]);
    expect(where.leaseExpiresAt.lt).toBeInstanceOf(Date);
  });

  it("clears the lease when returning a task to the queue", async () => {
    await reclaimExpiredTasks();
    expect(mockUpdateMany.mock.calls[0][0].data).toMatchObject({
      state: "queued",
      leaseTokenHash: null,
      leaseExpiresAt: null,
    });
  });
});

describe("claiming", () => {
  it("returns nothing when there is no queued work", async () => {
    mockFindFirst.mockResolvedValue(null);
    expect(await claimNextTask("u1")).toBeNull();
  });

  it("hands back a raw token but stores only its hash", async () => {
    mockFindFirst.mockResolvedValue({ id: "t1", url: "https://x/1", host: "x" });
    const claim = await claimNextTask("u1");
    expect(claim?.leaseToken).toMatch(/^[a-f0-9]{64}$/);
    // The raw token lives only in the extension; a database leak must not hand
    // someone else the ability to report on this task.
    const stored = mockUpdateMany.mock.calls.at(-1)![0].data.leaseTokenHash;
    expect(stored).toBe(hashLease(claim!.leaseToken));
    expect(stored).not.toBe(claim!.leaseToken);
  });

  it("only claims a task that is still queued", async () => {
    mockFindFirst.mockResolvedValue({ id: "t1", url: "https://x/1", host: "x" });
    await claimNextTask("u1");
    // Two browsers on one account must not both believe they own it.
    expect(mockUpdateMany.mock.calls.at(-1)![0].where).toMatchObject({ id: "t1", state: "queued" });
  });

  it("gives nothing to the loser of a race", async () => {
    mockFindFirst.mockResolvedValue({ id: "t1", url: "https://x/1", host: "x" });
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }); // reclaim
    mockUpdateMany.mockResolvedValueOnce({ count: 0 }); // lost the claim
    expect(await claimNextTask("u1")).toBeNull();
  });

  it("counts the attempt so a task cannot be retried forever", async () => {
    mockFindFirst.mockResolvedValue({ id: "t1", url: "https://x/1", host: "x" });
    await claimNextTask("u1");
    expect(mockUpdateMany.mock.calls.at(-1)![0].data.attempts).toEqual({ increment: 1 });
  });

  it("sets an expiry so an abandoned tab frees the task", async () => {
    mockFindFirst.mockResolvedValue({ id: "t1", url: "https://x/1", host: "x" });
    const before = Date.now();
    const claim = await claimNextTask("u1");
    expect(claim!.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 1000);
  });
});

describe("ownership", () => {
  it("requires the user AND the lease token", async () => {
    mockFindFirst.mockResolvedValue(null);
    expect(await ownsTask("u1", "t1", "wrong")).toBeNull();
    // The user alone is not enough, or one browser could report progress on the
    // task another browser is executing.
    expect(mockFindFirst.mock.calls[0][0].where).toMatchObject({
      id: "t1", userId: "u1", leaseTokenHash: hashLease("wrong"),
    });
  });

  it("rejects an expired lease even with the right token", async () => {
    mockFindFirst.mockResolvedValue({
      id: "t1", leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    expect(await ownsTask("u1", "t1", "tok")).toBeNull();
  });

  it("accepts a live lease", async () => {
    mockFindFirst.mockResolvedValue({
      id: "t1", leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(await ownsTask("u1", "t1", "tok")).not.toBeNull();
  });
});
