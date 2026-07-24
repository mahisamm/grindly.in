import { describe, expect, it, vi } from "vitest";

const { rm } = vi.hoisted(() => ({ rm: vi.fn().mockResolvedValue(undefined) }));

vi.mock("node:fs/promises", () => ({ default: { rm } }));
vi.mock("@/lib/session", () => ({
  getUid: vi.fn().mockResolvedValue("beta-user"),
  clearUid: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn().mockResolvedValue({ email: "beta@example.test" }),
      delete: vi.fn(),
    },
    passwordResetToken: { deleteMany: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([]),
  },
}));

import { DELETE } from "@/app/api/account/route";

describe("account runtime-file cleanup regression", () => {
  it("erases every per-user runtime directory without trusting DB file paths", async () => {
    const response = await DELETE(
      new Request("http://localhost/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );

    expect(response.status).toBe(200);
    const paths = rm.mock.calls.map(([target]) => String(target).replaceAll("\\", "/"));
    for (const expected of [
      "data/tailored/beta-user",
      "data/resume_variants/beta-user",
      "data/screenshots/beta-user",
      "data/browser_profile/beta-user",
      "data/logs/optimize/beta-user",
    ]) {
      expect(paths.some((target) => target.endsWith(expected)), expected).toBe(true);
    }
    expect(rm).toHaveBeenCalledWith(
      expect.stringContaining("beta-user"),
      expect.objectContaining({ force: true }),
    );
  });
});
