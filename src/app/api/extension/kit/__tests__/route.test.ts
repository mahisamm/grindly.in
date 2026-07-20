import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockUserFindUnique, mockAppFindMany, mockRateLimited } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockAppFindMany: vi.fn(),
  mockRateLimited: vi.fn(),
}));

vi.mock("@/lib/extensionAuth", () => ({ authenticateExtension: mockAuth }));
vi.mock("@/lib/rateLimit", () => ({ isRateLimited: mockRateLimited }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique },
    application: { findMany: mockAppFindMany },
  },
}));

import { GET, OPTIONS } from "@/app/api/extension/kit/route";

function req(url: string) {
  return new Request(`http://localhost/api/extension/kit?url=${encodeURIComponent(url)}`, {
    headers: { authorization: "Bearer gx_test", origin: "chrome-extension://abc" },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockRateLimited.mockResolvedValue(false); // not limited, by default
  mockUserFindUnique.mockResolvedValue({
    name: "Mahendhar", email: "m@x.com", profile: { phone: "999", gpa: 8.7 },
  });
});

describe("GET /api/extension/kit", () => {
  it("401s a request with no/invalid extension token", async () => {
    mockAuth.mockResolvedValue(null);
    const res = await GET(req("https://internshala.com/x"));
    expect(res.status).toBe(401);
  });

  it("429s once the per-token rate limit is exceeded, before touching the DB", async () => {
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockRateLimited.mockResolvedValue(true);
    const res = await GET(req("https://internshala.com/x"));
    expect(res.status).toBe(429);
    expect(mockAppFindMany).not.toHaveBeenCalled();
    // keyed on the token identity, not the IP — this is a background worker call
    expect(mockRateLimited.mock.calls[0][0]).toBe("ext_kit:t1");
  });

  it("returns the kit for a due match on the current URL", async () => {
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockAppFindMany.mockResolvedValue([
      {
        id: "a1", jobTitle: "SDE Intern", company: "Acme",
        url: "https://internshala.com/internship/detail/abc-123",
        coverLetterText: "Hi Acme team...",
        answersJson: '[{"q":"Why?","a":"Because.","source":"ai"}]',
      },
    ]);
    // tab URL has extra tracking params + trailing slash — must still match
    const res = await GET(req("https://internshala.com/internship/detail/abc-123/?utm=x"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.matched).toBe(true);
    expect(body.company).toBe("Acme");
    expect(body.coverLetter).toBe("Hi Acme team...");
    expect(body.answers).toEqual([{ q: "Why?", a: "Because." }]);
    expect(body.profile).toEqual({ name: "Mahendhar", email: "m@x.com", phone: "999", gpa: 8.7 });
  });

  it("returns matched:false (not an error) when no banked match fits the page", async () => {
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockAppFindMany.mockResolvedValue([
      { id: "a1", jobTitle: "X", company: "Y", url: "https://internshala.com/other", coverLetterText: null, answersJson: null },
    ]);
    const res = await GET(req("https://linkedin.com/jobs/view/999"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.matched).toBe(false);
  });

  it("only ever queries the user's own kit-eligible rows (embargo respected)", async () => {
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockAppFindMany.mockResolvedValue([]);
    await GET(req("https://internshala.com/x"));
    const where = mockAppFindMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    // kitEligible(): OR[{status:matched, embargo-checked}, {status:approved}]
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR).toEqual([
      { status: "matched", OR: expect.any(Array) },
      { status: "approved" },
    ]);
  });

  it("serves the kit for an already-APPROVED row ('To submit') — not just matched", async () => {
    // Regression: approved is exactly when the user clicked "Open & submit" and
    // the kit is most useful — it must not vanish at that moment.
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockAppFindMany.mockResolvedValue([
      {
        id: "a2", jobTitle: "Full Stack Intern", company: "Zetheta",
        url: "https://linkedin.com/jobs/view/123",
        coverLetterText: "Hi Zetheta team...", answersJson: null,
      },
    ]);
    const res = await GET(req("https://linkedin.com/jobs/view/123"));
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.coverLetter).toBe("Hi Zetheta team...");
  });

  it("tolerates malformed answersJson without throwing", async () => {
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockAppFindMany.mockResolvedValue([
      { id: "a1", jobTitle: "X", company: "Y", url: "https://internshala.com/x", coverLetterText: "cl", answersJson: "{not json" },
    ]);
    const res = await GET(req("https://internshala.com/x"));
    const body = await res.json();
    expect(body.matched).toBe(true);
    expect(body.answers).toEqual([]);
  });

  it("preflight OPTIONS returns permissive CORS for the extension", async () => {
    const res = OPTIONS(new Request("http://localhost/api/extension/kit", {
      method: "OPTIONS", headers: { origin: "chrome-extension://abc" },
    }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("chrome-extension://abc");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});
