import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid, mockFindMany, mockUpdate, mockTransaction,
  mockRunFindFirst, mockRunCreate, mockSpawnWorkerKick,
  mockUserFindUnique, mockGetQuota, mockRemainingForApproval,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockRunFindFirst: vi.fn(),
  mockRunCreate: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockGetQuota: vi.fn(),
  mockRemainingForApproval: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    application: { findMany: mockFindMany, update: mockUpdate },
    agentRun: { findFirst: mockRunFindFirst, create: mockRunCreate },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));
vi.mock("@/lib/quota", () => ({ getQuota: mockGetQuota, remainingForApproval: mockRemainingForApproval }));
vi.mock("@/lib/notify", () => ({ notifyUser: vi.fn().mockResolvedValue({ delivered: false }) }));

import { POST } from "@/app/api/applications/approve-all/route";

beforeEach(() => {
  vi.resetAllMocks();
  mockTransaction.mockResolvedValue([]);
  mockRunFindFirst.mockResolvedValue(null);
  mockRunCreate.mockResolvedValue({ id: "run1" });
  mockUserFindUnique.mockResolvedValue({ plan: "free", accessStatus: "approved", role: "user", email: "u1@example.com" });
  mockGetQuota.mockResolvedValue({ kind: "daily", cap: 5, used: 0, remaining: 5 });
  mockRemainingForApproval.mockResolvedValue(5);
});

describe("POST /api/applications/approve-all", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  // The pipeline holds ~a month of matches (plan cap x 30). A plain
  // status:"matched" filter here would approve all ~300 in one tap and authorize a
  // month of applications the user was never even shown. Only the DUE ones.
  it("approves only the matches that have come due — never the whole pipeline", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindMany.mockResolvedValue([]);
    await POST();

    const where = mockFindMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.status).toBe("matched");
    // future-dated matches are excluded by the scheduledFor gate
    expect(where.OR).toEqual([
      { scheduledFor: null },
      { scheduledFor: { lte: expect.any(Date) } },
    ]);
  });

  // Regression: only appliedToday gated approve-all, not a pending-approved
  // backlog, so a user could approve daily with nothing submitted and bank an
  // unbounded backlog across many days.
  it("returns 402 when today's cap is already spoken for by a pending-approved backlog", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockRemainingForApproval.mockResolvedValue(0);
    const res = await POST();
    expect(res.status).toBe(402);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("returns approved: 0 and skips the transaction when nothing is matched", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindMany.mockResolvedValue([]);
    const res = await POST();
    const body = await res.json();
    expect(body).toEqual({ ok: true, approved: 0 });
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it("approves every matched application and appends the note to each reason", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindMany.mockResolvedValue([
      { id: "a1", reason: "good fit" },
      { id: "a2", reason: null },
    ]);
    mockUpdate.mockImplementation((args) => args);
    const res = await POST();
    const body = await res.json();

    expect(body).toMatchObject({ ok: true, approved: 2 });
    expect(mockTransaction).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
    data: { status: "approved", reason: "good fit — ready for your final browser submission" },
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a2" },
    data: { status: "approved", reason: " — ready for your final browser submission" },
    });
  });

  it("never queues a worker to submit the batch", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindMany.mockResolvedValue([
      { id: "a1", reason: "r" },
      { id: "a2", reason: "r" },
    ]);
    mockUpdate.mockImplementation((args) => args);

    await POST();

    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(mockSpawnWorkerKick).not.toHaveBeenCalled();
  });
});
