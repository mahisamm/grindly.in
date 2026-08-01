/**
 * Consent must be granted by the act of consenting.
 *
 * autoApply now defaults OFF, so nothing is pre-consented on a student's
 * behalf. That is only safe if the consent step actually turns it on:
 * `readiness.consent` requires `!!p.autoApply`, so a default of `false` that
 * survives onboarding means the agent never applies for ANY new account.
 *
 * The bug this guards against was `Boolean(form.autoApply ?? true)` — `??`
 * falls back on null/undefined only, never on a stored `false`. There is no
 * auto-apply toggle in onboarding, so the form value is always whatever
 * DEFAULTS says.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONSENT_VERSION, computeReadiness } from "@/lib/readiness";
import { DEFAULTS } from "@/lib/proffQuestions";

const onboarding = readFileSync(
  join(process.cwd(), "src/app/onboarding/page.tsx"),
  "utf8",
);

describe("auto-apply consent", () => {
  it("is not pre-granted in the shipped defaults", () => {
    expect(DEFAULTS.autoApply).toBe(false);
  });

  it("is granted explicitly by the activation step", () => {
    // Not `form.autoApply ?? true` — see the file header.
    expect(onboarding).toContain("autoApply: true");
    expect(onboarding).not.toContain("autoApply: Boolean(form.autoApply ?? true)");
  });

  it("has no onboarding toggle that could carry the value instead", () => {
    // If someone adds one later, this test should fail and force a re-think of
    // whether the activation step may still hard-code true.
    expect(onboarding).not.toMatch(/patchForm\(\s*["']autoApply["']/);
  });

  it("readiness stays unready while auto-apply is off", () => {
    const base = {
      name: "Priya",
      email: "p@example.com",
      profile: {
        resumeText: "x", resumeName: "cv.pdf", phone: "9876543210",
        education: "B.Tech", gradYear: 2027, preferredDomains: '["Web Development"]',
        autoApplyConsentAt: new Date(), consentVersion: CONSENT_VERSION,
        maxPerDay: 0, timezone: "Asia/Kolkata",
        autoApply: false,
      },
    };
    expect(computeReadiness(base as never).checks.consent).toBe(false);
    const on = { ...base, profile: { ...base.profile, autoApply: true } };
    expect(computeReadiness(on as never).checks.consent).toBe(true);
  });
});
