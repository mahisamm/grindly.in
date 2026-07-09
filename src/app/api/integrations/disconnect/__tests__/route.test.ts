import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockUpsert, mockUserUpdate } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockUpsert: vi.fn(),
  mockUserUpdate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    userIntegration: { upsert: mockUpsert },
    user: { update: mockUserUpdate },
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
});
