import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid, mockFindFirst, mockUpdate,
  mockRunFindFirst, mockRunCreate, mockSpawnWorkerKick,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockRunFindFirst: vi.fn(),
  mockRunCreate: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    application: { findFirst: mockFindFirst, update: mockUpdate },
    agentRun: { findFirst: mockRunFindFirst, create: mockRunCreate },
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));

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

  it("returns 404 when the application isn't in matched state (or isn't the user's)", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("scopes the lookup to this user's own application", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    await POST(makeReq({ id: "a1" }));
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: "a1", userId: "u1", status: "matched" },
    });
  });

  it("approves and appends a note to the reason", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "approved", reason: "good fit — approved by you" },
    });
  });

  // Approving used to only flip the status; the application wasn't sent until the
  // user happened to trigger a whole new agent run. The tap must queue the send.
  it("enqueues a submit-only run so the approved application actually gets sent", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });

    const res = await POST(makeReq({ id: "a1" }));

    expect(res.status).toBe(200);
    expect(mockRunCreate).toHaveBeenCalledWith({ data: { userId: "u1", mode: "approved" } });
    expect(mockSpawnWorkerKick).toHaveBeenCalled();
  });

  it("reuses an in-flight run instead of queueing a second one", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    mockRunFindFirst.mockResolvedValue({ id: "already-running" });

    const res = await POST(makeReq({ id: "a1" }));
    const body = await res.json();

    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(body.runId).toBe("already-running");
  });

  it("does not enqueue a run when the application isn't approvable", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);

    const res = await POST(makeReq({ id: "a1" }));

    expect(res.status).toBe(404);
    expect(mockRunCreate).not.toHaveBeenCalled();
    expect(mockSpawnWorkerKick).not.toHaveBeenCalled();
  });
});
