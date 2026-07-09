import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockFindFirst, mockUpdate, mockAudit } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { application: { findFirst: mockFindFirst, update: mockUpdate } },
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));

import { PATCH } from "@/app/api/applications/outcome/route";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/applications/outcome", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockUpdate.mockResolvedValue({});
  mockAudit.mockResolvedValue(undefined);
  mockFindFirst.mockResolvedValue({ id: "a1", url: "https://x/1", jobTitle: "Intern" });
});

describe("PATCH /api/applications/outcome", () => {
  it("returns 401 when no session", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await PATCH(makeReq({ id: "a1", outcome: "interview" }));
    expect(res.status).toBe(401);
  });

  it("returns 400 when id is missing", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await PATCH(makeReq({ outcome: "interview" }));
    expect(res.status).toBe(400);
  });

  it("rejects an unrecognized outcome value", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await PATCH(makeReq({ id: "a1", outcome: "ghosted" }));
    expect(res.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("returns 404 when the application isn't this user's", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);
    const res = await PATCH(makeReq({ id: "a1", outcome: "interview" }));
    expect(res.status).toBe(404);
  });

  it.each(["interview", "offer", "rejected", "no_response"])(
    "accepts the valid outcome %s",
    async (outcome) => {
      mockGetUid.mockResolvedValue("u1");
      const res = await PATCH(makeReq({ id: "a1", outcome }));
      expect(res.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "a1" },
        data: { outcome, outcomeAt: expect.any(Date) },
      });
    },
  );

  it("clears the outcome when null is sent, with no outcomeAt", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await PATCH(makeReq({ id: "a1", outcome: null }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { outcome: null, outcomeAt: null },
    });
  });

  it("writes an audit entry", async () => {
    mockGetUid.mockResolvedValue("u1");
    await PATCH(makeReq({ id: "a1", outcome: "offer" }));
    expect(mockAudit).toHaveBeenCalledWith(
      "outcome_set",
      expect.objectContaining({ userId: "u1", detail: "offer" }),
    );
  });
});
