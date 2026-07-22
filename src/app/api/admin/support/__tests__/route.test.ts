import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockRequireAdmin, mockAdminAudit, mockCount, mockFindMany, mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(),
  mockAdminAudit: vi.fn(),
  mockCount: vi.fn(),
  mockFindMany: vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/admin", () => ({ requireAdmin: mockRequireAdmin, adminAudit: mockAdminAudit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    supportTicket: { count: mockCount, findMany: mockFindMany, findUnique: mockFindUnique, update: mockUpdate },
  },
}));

import { GET } from "@/app/api/admin/support/route";
import { POST } from "@/app/api/admin/support/[id]/route";

const ADMIN = { admin: { id: "a1", email: "admin@x.com" } };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireAdmin.mockResolvedValue(ADMIN);
  mockAdminAudit.mockResolvedValue(undefined);
  mockCount.mockResolvedValue(0);
  mockFindMany.mockResolvedValue([]);
  mockFindUnique.mockResolvedValue({ id: "t1" });
  mockUpdate.mockResolvedValue({});
});

describe("GET /api/admin/support", () => {
  it("blocks non-admins", async () => {
    mockRequireAdmin.mockResolvedValue({ error: new Response("no", { status: 404 }) });
    const r = await GET(new Request("http://localhost/api/admin/support"));
    expect(r.status).toBe(404);
    expect(mockFindMany).not.toHaveBeenCalled();
  });

  it("lists tickets and parses their messages", async () => {
    mockCount.mockResolvedValueOnce(1).mockResolvedValueOnce(1); // total, then openCount
    mockFindMany.mockResolvedValue([{
      id: "t1", status: "open", subject: "S", category: "bug", severity: "high", summary: "sum",
      messagesJson: JSON.stringify([{ role: "user", content: "hi", at: "x" }]),
      createdAt: new Date(), updatedAt: new Date(),
      user: { email: "u@x.com", name: "U", plan: "free" },
    }]);
    const r = await GET(new Request("http://localhost/api/admin/support?status=open"));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.openCount).toBe(1);
    expect(j.tickets).toHaveLength(1);
    expect(j.tickets[0].messages).toHaveLength(1);
    expect(j.tickets[0].email).toBe("u@x.com");
  });
});

describe("POST /api/admin/support/[id]", () => {
  it("blocks non-admins", async () => {
    mockRequireAdmin.mockResolvedValue({ error: new Response("no", { status: 404 }) });
    const r = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "resolve" }) }),
      ctx("t1"),
    );
    expect(r.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("rejects an invalid action", async () => {
    const r = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "delete" }) }),
      ctx("t1"),
    );
    expect(r.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("404s an unknown ticket", async () => {
    mockFindUnique.mockResolvedValue(null);
    const r = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "resolve" }) }),
      ctx("t1"),
    );
    expect(r.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("resolves a ticket and writes an admin audit", async () => {
    const r = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "resolve" }) }),
      ctx("t1"),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, status: "resolved" });
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "resolved" } });
    expect(mockAdminAudit).toHaveBeenCalledWith(ADMIN.admin, "support_resolve", "t1", expect.any(String));
  });

  it("reopens a resolved ticket", async () => {
    const r = await POST(
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ action: "reopen" }) }),
      ctx("t1"),
    );
    expect(await r.json()).toMatchObject({ ok: true, status: "open" });
    expect(mockUpdate).toHaveBeenCalledWith({ where: { id: "t1" }, data: { status: "open" } });
  });
});
