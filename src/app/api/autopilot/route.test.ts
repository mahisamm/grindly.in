import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The number labelled "Sent today" must mean sent.
 *
 * A live run made five browser tasks click Submit and never get a
 * confirmation. Each held its reserved slot — correctly, since an application
 * that may have reached an employer must not be sent twice — and the panel read
 * that reservation ledger straight into "Sent today 5/5". Nothing had been
 * sent. A dashboard that inflates "applied" is lying to someone about their own
 * job search, which is the one thing this panel exists not to do.
 */

const { mockUsageFind, mockAppCount, mockAppFindMany, mockTaskFindMany, mockTokenFind, mockUserFind, mockUid } =
  vi.hoisted(() => ({
    mockUsageFind: vi.fn(), mockAppCount: vi.fn(), mockAppFindMany: vi.fn(),
    mockTaskFindMany: vi.fn(), mockTokenFind: vi.fn(), mockUserFind: vi.fn(), mockUid: vi.fn(),
  }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFind },
    dailyUsage: { findUnique: mockUsageFind },
    application: { count: mockAppCount, findMany: mockAppFindMany },
    browserTask: { findMany: mockTaskFindMany },
    extensionToken: { findFirst: mockTokenFind },
  },
}));
vi.mock("@/lib/readiness", () => ({
  computeReadiness: () => ({ ready: true, missing: [], checks: { consent: true } }),
}));

import { GET, startOfLocalDay } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mockUid.mockResolvedValue("u1");
  mockUserFind.mockResolvedValue({
    name: "A", email: "a@b.c",
    profile: { maxPerDay: 5, timezone: "Asia/Kolkata" },
  });
  mockUsageFind.mockResolvedValue({ submitted: 5, attempted: 7 });
  mockAppCount.mockResolvedValue(0);
  mockAppFindMany.mockResolvedValue([]);
  mockTaskFindMany.mockResolvedValue([]);
  mockTokenFind.mockResolvedValue(null);
});

vi.mock("@/lib/session", () => ({ getUid: () => mockUid() }));

async function today() {
  return (await (await GET()).json()).today;
}

describe("what the panel calls sent", () => {
  it("does not count a reservation as a submission", async () => {
    // Five slots spent, nothing confirmed: the honest answer is zero.
    expect((await today()).submitted).toBe(0);
  });

  it("still spends the allowance on an unconfirmed attempt", async () => {
    // The slot is held on purpose — that attempt may have reached the employer,
    // and a refund here is what would let a duplicate out.
    const t = await today();
    expect(t.remaining).toBe(0);
    expect(t.reserved).toBe(5);
  });

  it("counts what actually went out when applications are applied", async () => {
    mockAppCount.mockResolvedValue(3);
    expect((await today()).submitted).toBe(3);
  });

  it("counts sends from the user's midnight, not UTC's", async () => {
    await today();
    const where = mockAppCount.mock.calls[0][0].where;
    expect(where.status).toBe("applied");
    expect(where.appliedAt.gte).toBeInstanceOf(Date);
  });

  it("survives the count failing without claiming a number it doesn't have", async () => {
    mockAppCount.mockRejectedValue(new Error("db down"));
    expect((await today()).submitted).toBe(0);
  });
});

describe("the start of someone's day", () => {
  it("is 18:30 UTC the previous day for Asia/Kolkata", () => {
    // UTC midnight is 5.5 hours INTO an Indian user's day, so counting from it
    // drops everything an overnight run sent before 05:30.
    const start = startOfLocalDay("Asia/Kolkata", new Date("2026-07-26T16:20:00Z"));
    expect(start.toISOString()).toBe("2026-07-25T18:30:00.000Z");
  });

  it("does not throw on a zone it has never heard of", () => {
    expect(startOfLocalDay("Not/AZone")).toBeInstanceOf(Date);
  });
});
