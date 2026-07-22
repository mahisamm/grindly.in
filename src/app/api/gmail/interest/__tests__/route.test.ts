import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetUid, mockUserUpdate, mockAudit } = vi.hoisted(() => ({
  mockGetUid: vi.fn(),
  mockUserUpdate: vi.fn(),
  mockAudit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { update: mockUserUpdate } },
}));
vi.mock("@/lib/audit", () => ({ audit: mockAudit }));

import { POST } from "@/app/api/gmail/interest/route";

beforeEach(() => {
  vi.resetAllMocks();
  mockUserUpdate.mockResolvedValue({});
  mockAudit.mockResolvedValue(undefined);
});

describe("POST /api/gmail/interest", () => {
  it("returns 401 with no session and never writes", async () => {
    mockGetUid.mockResolvedValue(null);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("flags the user's interest and audits it", async () => {
    mockGetUid.mockResolvedValue("u1");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { gmailScanInterest: true },
    });
    expect(mockAudit).toHaveBeenCalledWith("gmail_scan_interest", { userId: "u1" });
  });
});
