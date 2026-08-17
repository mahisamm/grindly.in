import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  LIMITS, UNLIMITED, daysRemaining, effectivePlan, formatLimit, isUnlimited, limitsFor,
} from "@/lib/plans";

/**
 * The admin tier.
 *
 * It is granted by `role = 'admin'` on the user row, which only
 * scripts/seed-admin.mjs sets and only from ADMIN_EMAIL — so it cannot be
 * reached by signing up, by paying, or by anything a request can do. These
 * tests hold that boundary in both directions: an admin is never capped, and
 * nobody else is ever uncapped.
 */
describe("the admin tier", () => {
  const admin = { role: "admin", plan: null, planExpiresAt: null };

  it("is not reachable by a plan value alone", () => {
    // The one that matters. If `plan` could name the tier, a payment webhook
    // bug or a stray update would be enough to hand it out.
    expect(effectivePlan({ plan: "admin", planExpiresAt: null })).toBe("free");
    expect(effectivePlan({ plan: "admin", planExpiresAt: new Date(Date.now() + 1e9) }))
      .toBe("free");
  });

  it("comes from the role and does not expire", () => {
    expect(effectivePlan(admin)).toBe("admin");
    // An admin whose pass ran out last year is still the operator.
    expect(effectivePlan({ role: "admin", plan: "pass", planExpiresAt: new Date(0) }))
      .toBe("admin");
  });

  it("uncaps every meter", () => {
    const limits = limitsFor(admin);
    for (const [key, value] of Object.entries(limits)) {
      expect(isUnlimited(value), `${key} is still capped at ${value}`).toBe(true);
    }
  });

  it("leaves everyone else exactly as they were", () => {
    expect(limitsFor({ plan: null, planExpiresAt: null })).toEqual(LIMITS.free);
    expect(limitsFor({ role: "user", plan: null, planExpiresAt: null })).toEqual(LIMITS.free);
    const live = new Date(Date.now() + 86_400_000);
    expect(limitsFor({ role: "user", plan: "pass", planExpiresAt: live })).toEqual(LIMITS.pass);
    expect(limitsFor({ plan: "pack", planExpiresAt: live })).toEqual(LIMITS.pack);
    // An expired pass is a free account, role or not.
    expect(limitsFor({ role: "user", plan: "pass", planExpiresAt: new Date(0) }))
      .toEqual(LIMITS.free);
  });

  it("shows no countdown, because there is nothing counting down", () => {
    expect(daysRemaining(admin)).toBeNull();
    expect(daysRemaining({ role: "admin", plan: "pass", planExpiresAt: new Date(Date.now() + 1e9) }))
      .toBeNull();
  });

  it("prints the word rather than the number", () => {
    // 1000000 on a dashboard is a bug someone will report.
    expect(formatLimit(UNLIMITED)).toBe("unlimited");
    expect(formatLimit(LIMITS.free.resumes)).toBe("2");
    expect(isUnlimited(LIMITS.pass.variantRunsPerDay)).toBe(false);
  });

  it("is still a bound, so a runaway loop cannot run forever", () => {
    // Not Infinity: these values are serialised to the browser, and
    // JSON.stringify(Infinity) is null — which would reach the dashboard as
    // "1 of null used on your plan".
    for (const value of Object.values(LIMITS.admin)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(JSON.parse(JSON.stringify({ value })).value).toBe(value);
    }
  });
});

describe("every place a plan is read from the database", () => {
  /**
   * `effectivePlan` reads `role`, so any Prisma `select` feeding it must
   * include `role`. Miss it on one path and that path silently applies the
   * free tier while the rest of the app shows no limit — which is exactly what
   * happened in `quota.reserve` and in the target-limit check, both of which
   * selected only plan and planExpiresAt.
   */
  const files = [
    "src/lib/quota.ts",
    "src/app/api/resumes/[id]/variants/route.ts",
  ];

  it.each(files)("%s selects role alongside plan", (file) => {
    const source = fs.readFileSync(path.join(process.cwd(), file), "utf8");
    const selects = source.match(/select:\s*\{[^}]*plan:\s*true[^}]*\}/g) ?? [];
    expect(selects.length, `no plan-bearing select found in ${file}`).toBeGreaterThan(0);
    for (const block of selects) {
      expect(block, `a select in ${file} reads plan without role`).toMatch(/role:\s*true/);
    }
  });
});
