import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuth, mockUserFindUnique, mockAppFindMany } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockAppFindMany: vi.fn(),
}));

vi.mock("@/lib/extensionAuth", () => ({ authenticateExtension: mockAuth }));
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

  it("only ever queries the user's own DUE matches (embargo respected)", async () => {
    mockAuth.mockResolvedValue({ userId: "u1", tokenId: "t1" });
    mockAppFindMany.mockResolvedValue([]);
    await GET(req("https://internshala.com/x"));
    const where = mockAppFindMany.mock.calls[0][0].where;
    expect(where.userId).toBe("u1");
    expect(where.status).toBe("matched");
    // dueNow() adds the not-embargoed OR clause
    expect(Array.isArray(where.OR)).toBe(true);
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
