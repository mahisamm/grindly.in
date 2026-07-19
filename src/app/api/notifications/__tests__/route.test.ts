import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockFindMany, mockCount, mockUpdateMany } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindMany: vi.fn(),
  mockCount: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { notification: { findMany: mockFindMany, count: mockCount, updateMany: mockUpdateMany } },
}));

import { GET, POST } from "@/app/api/notifications/route";

function postReq(body: Record<string, unknown>) {
  return new Request("http://localhost/api/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFindMany.mockResolvedValue([
    { id: "n1", tier: "urgent", title: "Ready", body: "b", readAt: null, createdAt: new Date() },
  ]);
  mockCount.mockResolvedValue(1);
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("GET /api/notifications", () => {
  it("401 without a session", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("returns unread count and items with a derived read flag, scoped to inapp", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await GET();
    const body = await res.json();
    expect(body.unread).toBe(1);
    expect(body.items[0].read).toBe(false);
    expect(mockFindMany.mock.calls[0][0].where).toMatchObject({ userId: "u1", channel: "inapp" });
  });
});

describe("POST /api/notifications", () => {
  it("401 without a session", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await POST(postReq({ all: true }))).status).toBe(401);
  });

  it("marks all unread as read for this user only", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(postReq({ all: true }));
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", channel: "inapp", readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it("rejects an empty mark request", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(postReq({}));
    expect(res.status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});
