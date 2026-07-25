import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockGetUid, mockFindUnique, mockUpdate } = vi.hoisted(() => ({
  mockGetUid: vi.fn(), mockFindUnique: vi.fn(), mockUpdate: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ getUid: mockGetUid }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mockFindUnique, update: mockUpdate } },
}));

import { POST } from "@/app/api/trial/activate/route";
import { CONSENT_VERSION } from "@/lib/readiness";

// Activation now refuses until the agent holds every fact it will state on a
// form plus a current consent to state them (lib/readiness). So the default
// fixture is a user who has actually finished setup; the incomplete cases get
// their own tests below.
const READY_PROFILE = {
  id: "p1",
  resumeName: "resume.pdf",
  phone: "+919000000000",
  education: "B.Tech CSE",
  gradYear: 2027,
  preferredDomains: '["web development"]',
  autoApply: true,
  autoApplyConsentAt: new Date("2026-07-25"),
  consentVersion: CONSENT_VERSION,
  maxPerDay: 5,
  timezone: "Asia/Kolkata",
};

beforeEach(() => {
  vi.resetAllMocks();
  mockGetUid.mockResolvedValue("u1");
  mockFindUnique.mockResolvedValue({ id: "u1", name: "A B", paid: false, profile: READY_PROFILE, accessStatus: "approved", role: "user", email: "u1@example.com" });
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
    mockFindUnique.mockResolvedValue({ id: "u1", name: "A B", paid: false, profile: READY_PROFILE, accessStatus: "pending", role: "user", email: "u1@example.com" });
    const res = await POST();
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
  it("refuses activation until setup is complete", async () => {
    // Without this gate a user "activates", then the worker holds every send on
    // readiness — the product looks broken while it is in fact protecting them.
    mockFindUnique.mockResolvedValue({
      id: "u1", name: "A B", paid: false, accessStatus: "approved", role: "user",
      email: "u1@example.com",
      profile: { ...READY_PROFILE, resumeName: null, autoApplyConsentAt: null },
    });
    const res = await POST();
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("setup_incomplete");
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("refuses when consent was given to older wording", async () => {
    mockFindUnique.mockResolvedValue({
      id: "u1", name: "A B", paid: false, accessStatus: "approved", role: "user",
      email: "u1@example.com",
      profile: { ...READY_PROFILE, consentVersion: "2020-01-01" },
    });
    expect((await POST()).status).toBe(409);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
