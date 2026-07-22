import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockUpsert, mockUserUpdate, mockAppFindMany, mockAppDeleteMany } =
  vi.hoisted(() => ({
    mockGetUid: vi.fn(),
    mockUpsert: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockAppFindMany: vi.fn(),
    mockAppDeleteMany: vi.fn(),
  }));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    userIntegration: { upsert: mockUpsert },
    user: { update: mockUserUpdate },
    application: { findMany: mockAppFindMany, deleteMany: mockAppDeleteMany },
  },
}));

import { POST } from "@/app/api/integrations/disconnect/route";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/integrations/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpsert.mockResolvedValue({});
  mockUserUpdate.mockResolvedValue({});
  mockAppFindMany.mockResolvedValue([]);
  mockAppDeleteMany.mockResolvedValue({ count: 0 });
});

describe("POST /api/integrations/disconnect", () => {
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

  it("disconnects a known platform", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({ platform: "naukri" }));
    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { status: "disconnected", connectedAt: null },
      }),
    );
  });

  it("also clears the legacy internshalaConnected flag when disconnecting internshala", async () => {
    mockGetUid.mockResolvedValue("u1");
    await POST(makeReq({ platform: "internshala" }));
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { internshalaConnected: false },
    });
  });

  it("does not touch the legacy flag for other platforms", async () => {
    mockGetUid.mockResolvedValue("u1");
    await POST(makeReq({ platform: "linkedin" }));
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("does not fail the request if the integrations table isn't migrated yet", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockUpsert.mockRejectedValue(new Error("no such table: user_integrations"));
    const res = await POST(makeReq({ platform: "linkedin" }));
    expect(res.status).toBe(200);
  });

  it("withdraws only NOT-YET-SENT matches from the disconnected platform", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAppFindMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    await POST(makeReq({ platform: "linkedin" }));

    // Scoped to this user + this platform (via the Job relation), pending statuses only.
    expect(mockAppFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "u1",
          status: { in: ["matched", "approved", "needs_review"] },
          job: { source: "linkedin" },
        }),
      }),
    );
    expect(mockAppDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ["a1", "a2"] } } });
  });

  it("deletes nothing when the platform has no pending matches", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAppFindMany.mockResolvedValue([]);
    await POST(makeReq({ platform: "naukri" }));
    expect(mockAppDeleteMany).not.toHaveBeenCalled();
  });

  it("still succeeds if the match cleanup throws", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockAppFindMany.mockRejectedValue(new Error("db down"));
    const res = await POST(makeReq({ platform: "unstop" }));
    expect(res.status).toBe(200);
  });
});
