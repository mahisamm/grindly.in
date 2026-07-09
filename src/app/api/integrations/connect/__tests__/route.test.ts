import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockGetUid,
  mockUserFindUnique,
  mockUpsert,
  mockExistsSync,
  mockMkdirSync,
  mockOpenSync,
  mockSpawn,
} = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockUpsert: vi.fn(),
  mockExistsSync: vi.fn(),
  mockMkdirSync: vi.fn(),
  mockOpenSync: vi.fn(),
  mockSpawn: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockUserFindUnique }, userIntegration: { upsert: mockUpsert } },
}));
vi.mock("node:fs", () => ({
  default: { existsSync: mockExistsSync, mkdirSync: mockMkdirSync, openSync: mockOpenSync },
}));
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import { POST } from "@/app/api/integrations/connect/route";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/integrations/connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  mockUserFindUnique.mockResolvedValue({ id: "u1" });
  mockUpsert.mockResolvedValue({});
  mockExistsSync.mockReturnValue(true); // connect_platform.py + log dir "exist"
  mockOpenSync.mockReturnValue(3);
  mockSpawn.mockReturnValue({ on: vi.fn(), unref: vi.fn(), pid: 1234 });
});

describe("POST /api/integrations/connect", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(makeReq({ platform: "linkedin" }));
    expect(res.status).toBe(401);
  });

  it("rejects an unknown platform", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({ platform: "myspace" }));
    expect(res.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("marks connecting and defers to the connect service in production (no local spawn)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({ platform: "linkedin" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, platform: "linkedin", mode: "remote" });
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { status: "connecting" },
        create: { userId: "u1", platform: "linkedin", status: "connecting" },
      }),
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("returns 404 when user not found", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockUserFindUnique.mockResolvedValue(null);
    const res = await POST(makeReq({ platform: "linkedin" }));
    expect(res.status).toBe(404);
  });

  it("marks the integration as connecting and spawns the connect script", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({ platform: "linkedin" }));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { status: "connecting" },
        create: { userId: "u1", platform: "linkedin", status: "connecting" },
      }),
    );
    expect(mockSpawn).toHaveBeenCalled();
  });

  it("returns 500 with a helpful message when spawning the browser fails", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockSpawn.mockImplementation(() => { throw new Error("ENOENT"); });
    const res = await POST(makeReq({ platform: "linkedin" }));
    expect(res.status).toBe(500);
  });
});
