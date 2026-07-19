import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid,
  mockAccess,
  mockUserFindUnique,
  mockAgentRunFindFirst,
  mockAgentRunCreate,
  mockUserIntegrationCount,
  mockSpawnWorkerKick,
  mockGetQuota,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockAccess: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockAgentRunFindFirst: vi.fn(),
  mockAgentRunCreate: vi.fn(),
  mockUserIntegrationCount: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
  mockGetQuota: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    userIntegration: { count: mockUserIntegrationCount },
    agentRun: {
      findFirst: mockAgentRunFindFirst,
      create: mockAgentRunCreate,
    },
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));
vi.mock("@/lib/quota", () => ({ getQuota: mockGetQuota }));
vi.mock("node:fs/promises", () => ({ default: { access: mockAccess } }));

import { POST, GET } from "@/app/api/agent/run/route";

function postReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function getReq(id?: string) {
  const url = id ? `http://localhost/api/agent/run?id=${id}` : "http://localhost/api/agent/run";
  return new Request(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockAccess.mockResolvedValue(undefined); // worker.py present by default
  // Connected platform by default so live runs are allowed; individual tests
  // override to exercise the no-platform gate.
  mockUserFindUnique.mockResolvedValue({ id: "u1", internshalaConnected: true, accessStatus: "approved", role: "user", email: "u1@example.com" });
  mockUserIntegrationCount.mockResolvedValue(1);
  mockAgentRunFindFirst.mockResolvedValue(null);
  mockAgentRunCreate.mockResolvedValue({ id: "run1" });
  mockGetQuota.mockResolvedValue({ kind: "daily", cap: 5, used: 0, remaining: 5 });
});

describe("POST /api/agent/run", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(postReq());
    expect(res.status).toBe(401);
  });

  it("returns 404 when user not found", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockUserFindUnique.mockResolvedValue(null);
    const res = await POST(postReq());
    expect(res.status).toBe(404);
  });

  it("blocks a not-yet-approved account with 403 access_pending", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockUserFindUnique.mockResolvedValue({ id: "u1", internshalaConnected: true, accessStatus: "pending", role: "user", email: "u1@example.com" });
    const res = await POST(postReq());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("access_pending");
    expect(mockAgentRunCreate).not.toHaveBeenCalled();
  });

  it("blocks a live run after the daily limit is reached", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockGetQuota.mockResolvedValue({ kind: "daily", cap: 5, used: 5, remaining: 0 });
    const res = await POST(postReq());
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe("daily_limit_reached");
    expect(mockAgentRunCreate).not.toHaveBeenCalled();
  });

  it("returns 500 when worker.py isn't installed", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const res = await POST(postReq());
    expect(res.status).toBe(500);
  });

  it("returns 400 for a live run with no connected platform", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockUserFindUnique.mockResolvedValue({ id: "u1", internshalaConnected: false, accessStatus: "approved", role: "user", email: "u1@example.com" });
    mockUserIntegrationCount.mockResolvedValue(0);
    const res = await POST(postReq());
    expect(res.status).toBe(400);
    expect(mockAgentRunCreate).not.toHaveBeenCalled();
  });

  it("always creates a live run — there is no mock/demo mode", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("live");
    expect(mockAgentRunCreate).toHaveBeenCalledWith({ data: { userId: "u1", mode: "live" } });
  });

  it("ignores a mode passed in the request body — mode is not client-controlled", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(postReq({ mode: "mock" }));
    const body = await res.json();
    expect(body.mode).toBe("live");
    expect(mockAgentRunCreate).toHaveBeenCalledWith({ data: { userId: "u1", mode: "live" } });
  });

  it("reuses an existing queued/running run instead of creating a duplicate", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAgentRunFindFirst.mockResolvedValue({ id: "existing_run" });
    const res = await POST(postReq());
    const body = await res.json();
    expect(body.runId).toBe("existing_run");
    expect(mockAgentRunCreate).not.toHaveBeenCalled();
  });

  it("analyzeOnly creates a fresh analyze run even with no platform connected", async () => {
    mockGetUid.mockResolvedValue("u1");
    // No connected platform — analyzeOnly must still work (it touches no board).
    mockUserFindUnique.mockResolvedValue({ id: "u1", internshalaConnected: false, accessStatus: "approved", role: "user", email: "u1@example.com" });
    mockUserIntegrationCount.mockResolvedValue(0);
    mockAgentRunFindFirst.mockResolvedValue({ id: "existing_run" });
    const res = await POST(postReq({ analyzeOnly: true }));
    const body = await res.json();
    expect(body.mode).toBe("analyze");
    expect(mockAgentRunCreate).toHaveBeenCalledWith({ data: { userId: "u1", mode: "analyze" } });
  });

  it("kicks the local worker on success", async () => {
    mockGetUid.mockResolvedValue("u1");
    await POST(postReq());
    expect(mockSpawnWorkerKick).toHaveBeenCalledWith(process.cwd(), "u1");
  });
});

describe("GET /api/agent/run", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await GET(getReq("run1"));
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await GET(getReq());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the run doesn't belong to this user", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAgentRunFindFirst.mockResolvedValue(null);
    const res = await GET(getReq("run1"));
    expect(res.status).toBe(404);
  });

  it("returns parsed JSON result on success", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAgentRunFindFirst.mockResolvedValue({
      status: "done",
      result: JSON.stringify({ applied: 3, matched: 5, failed: 1 }),
      error: null,
    });
    const res = await GET(getReq("run1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("done");
    expect(body.result).toEqual({ applied: 3, matched: 5, failed: 1 });
  });

  it("falls back to null result on corrupt JSON instead of throwing", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAgentRunFindFirst.mockResolvedValue({ status: "done", result: "{not json", error: null });
    const res = await GET(getReq("run1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result).toBeNull();
  });
});
