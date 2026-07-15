import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid, mockFindMany, mockUpdate, mockTransaction,
  mockRunFindFirst, mockRunCreate, mockSpawnWorkerKick,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdate: vi.fn(),
  mockTransaction: vi.fn(),
  mockRunFindFirst: vi.fn(),
  mockRunCreate: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    application: { findMany: mockFindMany, update: mockUpdate },
    agentRun: { findFirst: mockRunFindFirst, create: mockRunCreate },
    $transaction: mockTransaction,
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));

import { POST } from "@/app/api/applications/approve-all/route";

beforeEach(() => {
  vi.resetAllMocks();
  mockTransaction.mockResolvedValue([]);
  mockRunFindFirst.mockResolvedValue(null);
  mockRunCreate.mockResolvedValue({ id: "run1" });
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
      data: { status: "approved", reason: "good fit — approved by you" },
    });
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a2" },
      data: { status: "approved", reason: " — approved by you" },
    });
  });

  // Approving 12 jobs must queue ONE send, not 12 — and must queue it at all.
  it("enqueues exactly one submit-only run for the whole batch", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindMany.mockResolvedValue([
      { id: "a1", reason: "r" },
      { id: "a2", reason: "r" },
    ]);
    mockUpdate.mockImplementation((args) => args);

    await POST();

    expect(mockRunCreate).toHaveBeenCalledTimes(1);
    expect(mockRunCreate).toHaveBeenCalledWith({ data: { userId: "u1", mode: "approved" } });
    expect(mockSpawnWorkerKick).toHaveBeenCalled();
  });
});
