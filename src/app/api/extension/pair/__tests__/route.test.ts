import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockIssueToken, mockFindMany, mockUpdateMany } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockIssueToken: vi.fn(),
  mockFindMany: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/extensionAuth", () => ({ issueToken: mockIssueToken }));
vi.mock("@/lib/prisma", () => ({
  prisma: { extensionToken: { findMany: mockFindMany, updateMany: mockUpdateMany } },
}));

import { GET, POST, DELETE } from "@/app/api/extension/pair/route";

function jreq(method: string, body?: unknown) {
  return new Request("http://localhost/api/extension/pair", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("POST /api/extension/pair", () => {
  it("401s with no session", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await POST(jreq("POST", {}))).status).toBe(401);
  });

  it("issues a token scoped to the logged-in user and returns it once", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockIssueToken.mockResolvedValue("gx_rawtoken123");
    const res = await POST(jreq("POST", { label: "My Chrome" }));
    const body = await res.json();
    expect(body).toEqual({ ok: true, token: "gx_rawtoken123" });
    expect(mockIssueToken).toHaveBeenCalledWith("u1", "My Chrome");
  });

  it("defaults and truncates an oversized label rather than storing it raw", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockIssueToken.mockResolvedValue("gx_x");
    await POST(jreq("POST", { label: "x".repeat(200) }));
    expect((mockIssueToken.mock.calls[0][1] as string).length).toBe(60);
  });
});

describe("GET /api/extension/pair", () => {
  it("401s with no session", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("lists only this user's non-revoked tokens, metadata only", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindMany.mockResolvedValue([{ id: "t1", label: "Chrome", createdAt: new Date(), lastUsedAt: null }]);
    const res = await GET();
    const body = await res.json();
    expect(body.tokens).toHaveLength(1);
    const where = mockFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ userId: "u1", revokedAt: null });
    // never selects the token hash
    expect(mockFindMany.mock.calls[0][0].select.tokenHash).toBeUndefined();
  });
});

describe("DELETE /api/extension/pair", () => {
  it("401s with no session", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await DELETE(jreq("DELETE", { id: "t1" }))).status).toBe(401);
  });

  it("400s when neither id nor all is given", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await DELETE(jreq("DELETE", {}));
    expect(res.status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("revokes one token, scoped to the caller's own userId (can't touch another user's)", async () => {
    mockGetUid.mockResolvedValue("u1");
    await DELETE(jreq("DELETE", { id: "t1" }));
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "t1", userId: "u1" },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("revokes all of this user's tokens when all:true", async () => {
    mockGetUid.mockResolvedValue("u1");
    await DELETE(jreq("DELETE", { all: true }));
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });
});
