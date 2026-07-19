import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockFindFirst, mockUpdate, mockAudit, mockUserFindUnique, mockGetQuota } = vi.hoisted(() => ({
  mockGetUid: vi.fn(), mockFindFirst: vi.fn(), mockUpdate: vi.fn(), mockAudit: vi.fn(),
  mockUserFindUnique: vi.fn(), mockGetQuota: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { application: { findFirst: mockFindFirst, update: mockUpdate }, user: { findUnique: mockUserFindUnique } },
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));
vi.mock("@/lib/quota", () => ({ getQuota: mockGetQuota }));

import { POST } from "@/app/api/applications/submitted/route";

function makeReq(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/applications/submitted", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFindFirst.mockResolvedValue({ id: "a1", url: "https://example.test/job", jobTitle: "Intern" });
  mockUserFindUnique.mockResolvedValue({ plan: "free" });
  mockGetQuota.mockResolvedValue({ kind: "trial", cap: 5, used: 0, remaining: 5 });
  mockUpdate.mockResolvedValue({});
  mockAudit.mockResolvedValue(undefined);
});

describe("POST /api/applications/submitted", () => {
  it("requires a signed-in user and an application id", async () => {
    mockGetUid.mockResolvedValue(null);
    expect((await POST(makeReq({ id: "a1" }))).status).toBe(401);
    mockGetUid.mockResolvedValue("u1");
    expect((await POST(makeReq())).status).toBe(400);
  });

  it("only accepts an application already prepared for manual submission", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockFindFirst.mockResolvedValue(null);
    expect((await POST(makeReq({ id: "a1" }))).status).toBe(404);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("records the user's explicit confirmation without contacting a platform", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST(makeReq({ id: "a1" }));
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: expect.objectContaining({
        status: "applied", appliedAt: expect.any(Date),
        reason: "Submitted manually by you in your browser (Safe Apply Mode)",
      }),
    });
    expect(mockAudit).toHaveBeenCalledWith("manual_submission_confirmed", expect.objectContaining({ userId: "u1" }));
  });

  it("enforces quota when the user confirms a submission", async () => {
    mockGetUid.mockResolvedValue("u1");
    mockGetQuota.mockResolvedValue({ kind: "daily", cap: 5, used: 5, remaining: 0 });
    expect((await POST(makeReq({ id: "a1" }))).status).toBe(402);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
