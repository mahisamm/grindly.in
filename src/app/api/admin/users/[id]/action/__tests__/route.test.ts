import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

const { mockRequireAdmin, mockAdminAudit, mockUserFindUnique, mockUserUpdate, mockIntegrationUpdateMany } =
  vi.hoisted(() => ({
    mockRequireAdmin: vi.fn(),
    mockAdminAudit: vi.fn(),
    mockUserFindUnique: vi.fn(),
    mockUserUpdate: vi.fn(),
    mockIntegrationUpdateMany: vi.fn(),
  }));

vi.mock("@/lib/admin", () => ({ requireAdmin: mockRequireAdmin, adminAudit: mockAdminAudit }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockUserFindUnique, update: mockUserUpdate },
    userIntegration: { updateMany: mockIntegrationUpdateMany },
  },
}));

import { POST } from "@/app/api/admin/users/[id]/action/route";

function makeReq(body: unknown) {
  return new Request("http://localhost/api/admin/users/target1/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function ctx(id = "target1") {
  return { params: Promise.resolve({ id }) };
}

const ADMIN = { id: "admin1", email: "a@x.com", name: "Admin", role: "admin" };

beforeEach(() => {
  vi.resetAllMocks();
  mockRequireAdmin.mockResolvedValue({ admin: ADMIN });
  mockUserFindUnique.mockResolvedValue({ id: "target1", role: "user" });
  mockUserUpdate.mockResolvedValue({});
  mockIntegrationUpdateMany.mockResolvedValue({ count: 1 });
  mockAdminAudit.mockResolvedValue(undefined);
});

describe("POST /api/admin/users/[id]/action", () => {
  it("returns the requireAdmin error (404) for a non-admin caller — indistinguishable from a missing route", async () => {
    mockRequireAdmin.mockResolvedValue({ error: NextResponse.json({ error: "Not found" }, { status: 404 }) });
    const res = await POST(makeReq({ action: "pause" }), ctx());
    expect(res.status).toBe(404);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid action shape", async () => {
    const res = await POST(makeReq({ action: "nuke_everything" }), ctx());
    expect(res.status).toBe(400);
  });

  it("returns 400 when set_plan value isn't one of the known plans", async () => {
    const res = await POST(makeReq({ action: "set_plan", value: "enterprise" }), ctx());
    expect(res.status).toBe(400);
  });

  it("returns 404 when the target user doesn't exist", async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const res = await POST(makeReq({ action: "pause" }), ctx());
    expect(res.status).toBe(404);
  });

  it("pauses a user", async () => {
    const res = await POST(makeReq({ action: "pause" }), ctx());
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({ where: { id: "target1" }, data: { status: "paused" } });
  });

  it("resumes a user", async () => {
    await POST(makeReq({ action: "resume" }), ctx());
    expect(mockUserUpdate).toHaveBeenCalledWith({ where: { id: "target1" }, data: { status: "active" } });
  });

  it("sets plan", async () => {
    await POST(makeReq({ action: "set_plan", value: "pro" }), ctx());
    expect(mockUserUpdate).toHaveBeenCalledWith({ where: { id: "target1" }, data: { plan: "pro" } });
  });

  it("sets role for a different user", async () => {
    const res = await POST(makeReq({ action: "set_role", value: "admin" }), ctx());
    expect(res.status).toBe(200);
    expect(mockUserUpdate).toHaveBeenCalledWith({ where: { id: "target1" }, data: { role: "admin" } });
  });

  it("blocks an admin from changing their own role (can't lock themselves out)", async () => {
    const res = await POST(makeReq({ action: "set_role", value: "user" }), ctx("admin1"));
    expect(res.status).toBe(400);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("disconnects a platform integration for the target user", async () => {
    await POST(makeReq({ action: "disconnect", platform: "linkedin" }), ctx());
    expect(mockIntegrationUpdateMany).toHaveBeenCalledWith({
      where: { userId: "target1", platform: "linkedin" },
      data: { status: "disconnected", connectedAt: null },
    });
  });

  it("rejects an unknown platform on disconnect", async () => {
    const res = await POST(makeReq({ action: "disconnect", platform: "myspace" }), ctx());
    expect(res.status).toBe(400);
  });

  it("writes an admin audit entry naming the acting admin and target", async () => {
    await POST(makeReq({ action: "pause" }), ctx());
    expect(mockAdminAudit).toHaveBeenCalledWith(ADMIN, "pause", "target1", expect.any(String));
  });
});
