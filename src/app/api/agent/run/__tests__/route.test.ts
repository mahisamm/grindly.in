import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid,
  mockAccess,
  mockUserFindUnique,
  mockAgentRunFindFirst,
  mockAgentRunCreate,
  mockSpawnWorkerKick,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockAccess: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockAgentRunFindFirst: vi.fn(),
  mockAgentRunCreate: vi.fn(),
  mockSpawnWorkerKick: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    agentRun: {
      findFirst: mockAgentRunFindFirst,
      create: mockAgentRunCreate,
    },
  },
}));
vi.mock("@/lib/workerKick", () => ({ spawnWorkerKick: mockSpawnWorkerKick }));
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
  mockUserFindUnique.mockResolvedValue({ id: "u1" });
  mockAgentRunFindFirst.mockResolvedValue(null);
  mockAgentRunCreate.mockResolvedValue({ id: "run1" });
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

  it("returns 500 when worker.py isn't installed", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    const res = await POST(postReq());
    expect(res.status).toBe(500);
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

  it("analyzeOnly always creates a fresh analyze run, even with a queued run pending", async () => {
    mockGetUid.mockResolvedValue("u1");
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
