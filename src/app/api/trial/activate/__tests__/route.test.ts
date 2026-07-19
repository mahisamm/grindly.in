import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUid, mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockGetUid: vi.fn(), mockFindUnique: vi.fn(), mockUpdate: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}));

import { POST } from "@/app/api/trial/activate/route";

beforeEach(() => {
  vi.resetAllMocks();
  mockGetUid.mockResolvedValue("u1");
  mockFindUnique.mockResolvedValue({ id: "u1", paid: false, profile: { id: "p1" }, accessStatus: "approved", role: "user", email: "u1@example.com" });
  mockUpdate.mockResolvedValue({});
});

describe("POST /api/trial/activate", () => {
  it("requires a session", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await POST()).status).toBe(401);
  });

  it("activates free with a five-application profile limit", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: expect.objectContaining({
        paid: false, plan: "free", status: "active",
        profile: { update: { maxPerDay: 5 } },
      }),
    });
  });

  it("does not downgrade a paid user", async () => {
    mockFindUnique.mockResolvedValue({ id: "u1", paid: true, profile: {}, accessStatus: "approved", role: "user", email: "u1@example.com" });
    expect((await POST()).status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("blocks a not-yet-approved account with 403", async () => {
    mockFindUnique.mockResolvedValue({ id: "u1", paid: false, profile: { id: "p1" }, accessStatus: "pending", role: "user", email: "u1@example.com" });
    const res = await POST();
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
