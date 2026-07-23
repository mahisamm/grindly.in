import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequireAdmin, mockAppCount, mockAppFindMany, mockAppGroupBy, mockUserFindMany } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockAppCount: vi.fn(),
  mockAppFindMany: vi.fn(),
  mockAppGroupBy: vi.fn(),
  mockUserFindMany: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: mockRequireAdmin }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    application: { count: mockAppCount, findMany: mockAppFindMany, groupBy: mockAppGroupBy },
    user: { findMany: mockUserFindMany },
  },
}));

import { GET } from "@/app/api/admin/applications/route";

const req = (qs: string) => new Request(`http://localhost/api/admin/applications${qs}`);

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireAdmin.mockResolvedValue({ email: "admin@x.com" });
  mockAppCount.mockResolvedValue(0);
  mockAppFindMany.mockResolvedValue([]);
});

describe("GET /api/admin/applications", () => {
  it("refuses a non-admin", async () => {
    mockRequireAdmin.mockResolvedValue({ error: new Response("nope", { status: 404 }) });
    const r = await GET(req(""));
    expect(r.status).toBe(404);
    expect(mockAppFindMany).not.toHaveBeenCalled();
  });

  it("scopes the list to one user when userId is given", async () => {
    await GET(req("?userId=u1"));
    expect(mockAppFindMany.mock.calls[0][0].where).toMatchObject({ userId: "u1" });
    expect(mockAppCount.mock.calls[0][0].where).toMatchObject({ userId: "u1" });
  });

  it("combines userId with the status and platform filters", async () => {
    await GET(req("?userId=u1&status=applied&platform=internshala"));
    expect(mockAppFindMany.mock.calls[0][0].where).toMatchObject({
      userId: "u1", status: "applied", job: { source: "internshala" },
    });
  });

  // The point of the grouped mode: per-user totals that are correct across the
  // WHOLE table, not just the current page of the flat list.
  it("pivots per-user counts by status", async () => {
    mockAppGroupBy
      .mockResolvedValueOnce([
        { userId: "u1", status: "applied", _count: { _all: 3 } },
        { userId: "u1", status: "matched", _count: { _all: 5 } },
        { userId: "u1", status: "failed", _count: { _all: 1 } },
        { userId: "u2", status: "applied", _count: { _all: 2 } },
      ])
      .mockResolvedValueOnce([
        { userId: "u1", _max: { createdAt: new Date("2026-07-20T00:00:00Z") } },
        { userId: "u2", _max: { createdAt: new Date("2026-07-23T00:00:00Z") } },
      ]);
    mockUserFindMany.mockResolvedValue([
      { id: "u1", email: "a@x.com", name: "A", plan: "free", accessStatus: "approved" },
      { id: "u2", email: "b@x.com", name: null, plan: "plus", accessStatus: "pending" },
    ]);

    const r = await GET(req("?groupBy=user"));
    const j = await r.json();

    expect(j.groupBy).toBe("user");
    // Sorted by most recent activity, so the active user is on top.
    expect(j.users.map((u: { email: string }) => u.email)).toEqual(["b@x.com", "a@x.com"]);
    const u1 = j.users.find((u: { userId: string }) => u.userId === "u1");
    expect(u1).toMatchObject({ total: 9, applied: 3, matched: 5, failed: 1, skipped: 0 });
  });

  it("drops rows whose user was filtered out by the search", async () => {
    mockAppGroupBy
      .mockResolvedValueOnce([
        { userId: "u1", status: "applied", _count: { _all: 3 } },
        { userId: "u2", status: "applied", _count: { _all: 9 } },
      ])
      .mockResolvedValueOnce([{ userId: "u1", _max: { createdAt: new Date() } }]);
    // Search matched only u1 — u2's 9 applications must not leak into the view.
    mockUserFindMany.mockResolvedValue([
      { id: "u1", email: "a@x.com", name: "A", plan: "free", accessStatus: "approved" },
    ]);

    const r = await GET(req("?groupBy=user&q=a@x.com"));
    const j = await r.json();
    expect(j.users).toHaveLength(1);
    expect(j.users[0].userId).toBe("u1");
  });
});
