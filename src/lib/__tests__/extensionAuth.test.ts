import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockCreate, mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { extensionToken: { create: mockCreate, findUnique: mockFindUnique, update: mockUpdate } },
}));

import { issueToken, verifyToken, hashToken, bearerFrom } from "@/lib/extensionAuth";

beforeEach(() => {
  vi.resetAllMocks();
  mockCreate.mockResolvedValue({});
  mockUpdate.mockResolvedValue({});
});

describe("extension token", () => {
  it("issues a prefixed token and stores ONLY its hash (never the raw value)", async () => {
    let raw = "";
    mockCreate.mockImplementation(({ data }: { data: { tokenHash: string } }) => {
      // the stored value must be the hash, and must not equal the raw token
      expect(data.tokenHash).toHaveLength(64); // sha256 hex
      return Promise.resolve({});
    });
    raw = await issueToken("u1");
    expect(raw.startsWith("gx_")).toBe(true);
    const stored = mockCreate.mock.calls[0][0].data.tokenHash;
    expect(stored).toBe(hashToken(raw));
    expect(stored).not.toBe(raw);
  });

  it("verifies a valid token by hash and returns its owner", async () => {
    mockFindUnique.mockResolvedValue({ id: "t1", userId: "u1", revokedAt: null });
    const auth = await verifyToken("gx_whatever");
    expect(auth).toEqual({ userId: "u1", tokenId: "t1" });
    // looked up by HASH, never by the raw token
    expect(mockFindUnique.mock.calls[0][0].where.tokenHash).toBe(hashToken("gx_whatever"));
  });

  it("rejects a revoked token", async () => {
    mockFindUnique.mockResolvedValue({ id: "t1", userId: "u1", revokedAt: new Date() });
    expect(await verifyToken("gx_x")).toBeNull();
  });

  it("rejects a garbage / wrong-prefix / null token without hitting the DB", async () => {
    expect(await verifyToken(null)).toBeNull();
    expect(await verifyToken("not-a-grindly-token")).toBeNull();
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("parses a Bearer header, and only a Bearer header", () => {
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "Bearer gx_abc" } }))).toBe("gx_abc");
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "Basic zzz" } }))).toBeNull();
    expect(bearerFrom(new Request("http://x"))).toBeNull();
  });
});
