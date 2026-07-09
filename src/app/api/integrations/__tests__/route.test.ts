import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockFindMany } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { userIntegration: { findMany: mockFindMany } },
}));

import { GET } from "@/app/api/integrations/route";

beforeEach(() => {
  vi.resetAllMocks();
  mockGetUid.mockResolvedValue("u1");
});

describe("GET /api/integrations", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("defaults every platform to disconnected with no rows", async () => {
    mockFindMany.mockResolvedValue([]);
    const res = await GET();
    const body = await res.json();
    expect(body.integrations).toHaveLength(5);
    expect(body.integrations.every((i: { status: string }) => i.status === "disconnected")).toBe(true);
    expect(body.integrations.every((i: { connectToken: unknown }) => i.connectToken === null)).toBe(true);
  });

  it("surfaces connectToken while it is still live (not expired)", async () => {
    mockFindMany.mockResolvedValue([
      {
        platform: "linkedin",
        status: "connecting",
        connectedAt: null,
        connectToken: "tok_live",
        connectTokenExpiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    const res = await GET();
    const body = await res.json();
    const li = body.integrations.find((i: { platform: string }) => i.platform === "linkedin");
    expect(li.connectToken).toBe("tok_live");
  });

  it("never surfaces an expired connectToken", async () => {
    mockFindMany.mockResolvedValue([
      {
        platform: "linkedin",
        status: "connecting",
        connectedAt: null,
        connectToken: "tok_expired",
        connectTokenExpiresAt: new Date(Date.now() - 1000),
      },
    ]);
    const res = await GET();
    const body = await res.json();
    const li = body.integrations.find((i: { platform: string }) => i.platform === "linkedin");
    expect(li.connectToken).toBeNull();
  });

  it("falls back to defaults if the table doesn't exist yet", async () => {
    mockFindMany.mockRejectedValue(new Error('relation "user_integrations" does not exist'));
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.integrations).toHaveLength(5);
  });
});
