import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockFindFirst, mockUpdate } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { application: { findFirst: mockFindFirst, update: mockUpdate } },
}));

import { POST } from "@/app/api/applications/approve/route";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/applications/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdate.mockResolvedValue({});
});

describe("POST /api/applications/approve", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the application isn't in matched state (or isn't the user's)", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("scopes the lookup to this user's own application", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    await POST(makeReq({ id: "a1" }));
    expect(mockFindFirst).toHaveBeenCalledWith({
      where: { id: "a1", userId: "u1", status: "matched" },
    });
  });

  it("approves and appends a note to the reason", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue({ id: "a1", reason: "good fit" });
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { status: "approved", reason: "good fit — approved by you" },
    });
  });
});
