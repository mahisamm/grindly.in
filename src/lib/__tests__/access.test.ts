import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

const { mockFindUnique, mockReadAdminSettings } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockReadAdminSettings: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { accessAllowlist: { findUnique: mockFindUnique } },
}));
vi.mock("@/lib/adminSettings", () => ({
  readAdminSettings: mockReadAdminSettings,
}));

// OWNER_EMAIL is captured as a module-level const at import time in access.ts.
// ESM imports are hoisted above any top-level `process.env.ADMIN_EMAIL = ...`
// in this file, so the env var has to be set BEFORE the module is imported —
// done here via a scoped dynamic import in beforeAll, not a static import.
let resolveInitialAccess: typeof import("@/lib/access").resolveInitialAccess;
let hasAppAccess: typeof import("@/lib/access").hasAppAccess;

beforeAll(async () => {
  process.env.ADMIN_EMAIL = "owner@example.com";
  vi.resetModules();
  const mod = await import("@/lib/access");
  resolveInitialAccess = mod.resolveInitialAccess;
  hasAppAccess = mod.hasAppAccess;
});

beforeEach(() => {
  mockFindUnique.mockReset();
  mockReadAdminSettings.mockReset();
  mockReadAdminSettings.mockReturnValue({ openSignups: false });
});

describe("resolveInitialAccess", () => {
  it("always approves the owner email, regardless of openSignups or allowlist", async () => {
    mockReadAdminSettings.mockReturnValue({ openSignups: false });
    expect(await resolveInitialAccess("owner@example.com")).toBe("approved");
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("approves any email immediately when openSignups is on — the new default", async () => {
    mockReadAdminSettings.mockReturnValue({ openSignups: true });
    expect(await resolveInitialAccess("stranger@example.com")).toBe("approved");
    // Doesn't even need to touch the allowlist when signups are open.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it("falls back to the allowlist when openSignups is off", async () => {
    mockReadAdminSettings.mockReturnValue({ openSignups: false });
    mockFindUnique.mockResolvedValue({ email: "allowed@example.com" });
    expect(await resolveInitialAccess("allowed@example.com")).toBe("approved");
  });

  it("queues a non-allowlisted email as pending when openSignups is off", async () => {
    mockReadAdminSettings.mockReturnValue({ openSignups: false });
    mockFindUnique.mockResolvedValue(null);
    expect(await resolveInitialAccess("stranger@example.com")).toBe("pending");
  });

  it("fails closed to pending if the allowlist lookup throws", async () => {
    mockReadAdminSettings.mockReturnValue({ openSignups: false });
    mockFindUnique.mockRejectedValue(new Error("table not migrated yet"));
    expect(await resolveInitialAccess("stranger@example.com")).toBe("pending");
  });
});

describe("hasAppAccess", () => {
  it("grants admins and the owner regardless of accessStatus", () => {
    expect(hasAppAccess({ role: "admin", email: "x@example.com", accessStatus: "pending" })).toBe(true);
    expect(hasAppAccess({ role: "user", email: "owner@example.com", accessStatus: "pending" })).toBe(true);
  });

  it("otherwise requires accessStatus === 'approved'", () => {
    expect(hasAppAccess({ role: "user", email: "x@example.com", accessStatus: "pending" })).toBe(false);
    expect(hasAppAccess({ role: "user", email: "x@example.com", accessStatus: "approved" })).toBe(true);
  });
});
