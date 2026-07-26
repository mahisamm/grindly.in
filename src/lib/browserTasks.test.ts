import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockFindFirst, mockUpdateMany, mockFindMany, mockUsageUpsert, mockUsageUpdateMany } =
  vi.hoisted(() => ({
    mockFindFirst: vi.fn(),
    mockUpdateMany: vi.fn(),
    mockFindMany: vi.fn(),
    mockUsageUpsert: vi.fn(),
    mockUsageUpdateMany: vi.fn(),
  }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    browserTask: { findFirst: mockFindFirst, updateMany: mockUpdateMany, findMany: mockFindMany },
    dailyUsage: { upsert: mockUsageUpsert, updateMany: mockUsageUpdateMany },
  },
}));

import {
  claimNextTask, ownsTask, hashLease, reclaimExpiredTasks, reserveDailySlot,
  releaseDailySlot, localDateFor, LEASE_MS,
} from "./browserTasks";

const TASK = { id: "t1", applicationId: "a1", url: "https://x/1", host: "x" };
/** Claim with room to spare, unless a test says otherwise. */
const claim = (uid = "u1", cap = 5) => claimNextTask(uid, cap, "2026-07-26");

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockFindMany.mockResolvedValue([]);
  mockUsageUpsert.mockResolvedValue({});
  mockUsageUpdateMany.mockResolvedValue({ count: 1 }); // slot available
});

describe("lease reclaim", () => {
  beforeEach(() => {
    mockFindMany.mockResolvedValue([{ id: "t1", userId: "u1", reservedDate: "2026-07-26" }]);
  });

  it("only reclaims states that cannot have submitted", async () => {
    await reclaimExpiredTasks();
    const where = mockFindMany.mock.calls[0][0].where;
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

  it("gives back the daily slot the abandoned task was holding", async () => {
    // Otherwise a browser closed mid-fill silently burns one of the five for
    // the rest of the day, and the user is capped by a tab they shut.
    await reclaimExpiredTasks();
    expect(mockUsageUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", localDate: "2026-07-26", submitted: { gt: 0 } },
      data: { submitted: { decrement: 1 } },
    });
  });

  it("does nothing at all when no lease has expired", async () => {
    mockFindMany.mockResolvedValue([]);
    expect(await reclaimExpiredTasks()).toBe(0);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

describe("the daily cap", () => {
  it("carries the limit in the UPDATE's own WHERE", async () => {
    // Counting rows and then deciding cannot bound anything: two browsers both
    // read 4-of-5, both conclude there is room, and six applications go out
    // under a limit of five. A sent application cannot be recalled.
    await reserveDailySlot("u1", 5, "2026-07-26");
    expect(mockUsageUpdateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: "u1", localDate: "2026-07-26", submitted: { lt: 5 } },
      data: { submitted: { increment: 1 }, attempted: { increment: 1 } },
    });
  });

  it("refuses when the database says the day is full", async () => {
    mockUsageUpdateMany.mockResolvedValue({ count: 0 });
    expect(await reserveDailySlot("u1", 5, "2026-07-26")).toBe(false);
  });

  it("refuses outright when the cap is zero or unset", async () => {
    expect(await reserveDailySlot("u1", 0, "2026-07-26")).toBe(false);
    expect(mockUsageUpdateMany).not.toHaveBeenCalled();
  });

  it("never decrements a day that has nothing reserved", async () => {
    await releaseDailySlot("u1", "2026-07-26");
    expect(mockUsageUpdateMany.mock.calls[0][0].where.submitted).toEqual({ gt: 0 });
  });

  it("keeps `attempted` when a slot goes back", async () => {
    // The attempt really happened. That number exists to show a retry-heavy day
    // honestly, and rewriting it would hide exactly what it is for.
    await releaseDailySlot("u1", "2026-07-26");
    expect(mockUsageUpdateMany.mock.calls[0][0].data).toEqual({ submitted: { decrement: 1 } });
  });

  it("reads the date in the user's own timezone", () => {
    expect(localDateFor("Asia/Kolkata")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // An unknown zone must not throw and take the whole claim down with it.
    expect(localDateFor("Not/AZone")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("claiming", () => {
  beforeEach(() => mockFindFirst.mockResolvedValue(TASK));

  it("returns nothing when there is no queued work", async () => {
    mockFindFirst.mockResolvedValue(null);
    expect(await claim()).toMatchObject({ task: null, reason: "no_work" });
  });

  it("hands back a raw token but stores only its hash", async () => {
    const { task } = await claim();
    expect(task?.leaseToken).toMatch(/^[a-f0-9]{64}$/);
    // The raw token lives only in the extension; a database leak must not hand
    // someone else the ability to report on this task.
    const stored = mockUpdateMany.mock.calls.at(-1)![0].data.leaseTokenHash;
    expect(stored).toBe(hashLease(task!.leaseToken));
    expect(stored).not.toBe(task!.leaseToken);
  });

  it("only claims a task that is still queued", async () => {
    await claim();
    // Two browsers on one account must not both believe they own it.
    expect(mockUpdateMany.mock.calls.at(-1)![0].where).toMatchObject({ id: "t1", state: "queued" });
  });

  it("gives nothing to the loser of a race", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    expect(await claim()).toMatchObject({ task: null, reason: "no_work" });
  });

  it("counts the attempt so a task cannot be retried forever", async () => {
    await claim();
    expect(mockUpdateMany.mock.calls.at(-1)![0].data.attempts).toEqual({ increment: 1 });
  });

  it("sets an expiry so an abandoned tab frees the task", async () => {
    const before = Date.now();
    const { task } = await claim();
    expect(task!.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(before + LEASE_MS - 1000);
  });

  it("reserves the daily slot BEFORE handing the task out", async () => {
    // The browser can submit the moment it has a task, so asking permission
    // afterwards is asking after the employer already has the application.
    await claim();
    const reserveAt = mockUsageUpdateMany.mock.invocationCallOrder[0];
    const handOutAt = mockUpdateMany.mock.invocationCallOrder.at(-1)!;
    expect(reserveAt).toBeLessThan(handOutAt);
  });

  it("hands out nothing once the day is full", async () => {
    mockUsageUpdateMany.mockResolvedValue({ count: 0 });
    expect(await claim()).toMatchObject({ task: null, reason: "daily_cap" });
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("gives the slot back when there turns out to be no work", async () => {
    // Otherwise every idle poll quietly eats one of the day's five.
    mockFindFirst.mockResolvedValue(null);
    await claim();
    expect(mockUsageUpdateMany.mock.calls.at(-1)![0].data).toEqual({ submitted: { decrement: 1 } });
  });

  it("gives the slot back to the loser of a race", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    await claim();
    expect(mockUsageUpdateMany.mock.calls.at(-1)![0].data).toEqual({ submitted: { decrement: 1 } });
  });

  it("records which day's slot it took", async () => {
    // A lease can straddle midnight; releasing against "today" would return a
    // slot on the wrong day and leave the real one burnt.
    await claim();
    expect(mockUpdateMany.mock.calls.at(-1)![0].data.reservedDate).toBe("2026-07-26");
  });

  it("tells the caller which application the task is for", async () => {
    // Without it the claim endpoint cannot fetch the cover letter and answers
    // drafted for this specific employer.
    expect((await claim()).task?.applicationId).toBe("a1");
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
