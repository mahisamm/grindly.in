import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid, mockFindFirst, mockUpdate,
  mockRunFindFirst, mockRunCreate, mockSpawnWorkerKick,
  mockUserFindUnique, mockGetQuota,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockRunFindFirst: vi.fn(),
  mockRunCreate: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockGetQuota: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    application: { findFirst: mockFindFirst, update: mockUpdate },
    agentRun: { findFirst: mockRunFindFirst, create: mockRunCreate },
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));
vi.mock("@/lib/quota", () => ({ getQuota: mockGetQuota }));
vi.mock("@/lib/notify", () => ({ notifyUser: vi.fn().mockResolvedValue({ delivered: false }) }));

import { POST } from "@/app/api/applications/approve/route";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/applications/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdate.mockResolvedValue({});
  mockRunFindFirst.mockResolvedValue(null);
  mockRunCreate.mockResolvedValue({ id: "run1" });
  mockUserFindUnique.mockResolvedValue({ plan: "free", accessStatus: "approved", role: "user", email: "u1@example.com" });
  mockGetQuota.mockResolvedValue({ kind: "daily", cap: 5, used: 0, remaining: 5 });
});

describe("POST /api/applications/approve", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("does not approve after the daily limit is reached", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockGetQuota.mockResolvedValue({ kind: "trial", cap: 5, used: 5, remaining: 0 });
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(402);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the application isn't in matched state (or isn't the user's)", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  // Scoped to the user AND to the due-date gate. An id from the embargoed part of
  // the pipeline must be unapprovable even if the caller somehow learned it — the
  // list endpoint never serves those ids, but "the UI doesn't show it" is not
  // access control.
  it("scopes the lookup to this user's own, already-due application", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    await POST(makeReq({ id: "a1" }));

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "a1", userId: "u1", status: "matched" });
    expect(where.OR).toEqual([
      { scheduledFor: null },
      { scheduledFor: { lte: expect.any(Date) } },
    ]);
  });

  it("prepares the application for the user's final browser submission", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "approved", reason: "good fit — ready for your final browser submission" },
    });
  });

  it("never queues a worker to submit on the user's behalf", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });

    const res = await POST(makeReq({ id: "a1" }));

    expect(res.status).toBe(200);
    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(mockSpawnWorkerKick).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({ ok: true, requiresUserSubmit: true });
  });

  it("does not queue a run when the application isn't approvable", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);

    const res = await POST(makeReq({ id: "a1" }));

    expect(res.status).toBe(404);
    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(mockSpawnWorkerKick).not.toHaveBeenCalled();
  });
});
