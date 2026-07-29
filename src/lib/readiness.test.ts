import { describe, it, expect } from "vitest";
import { computeReadiness, CONSENT_VERSION } from "./readiness";

// The web half of the readiness gate. It must agree with agent/readiness.py on
// every case — the UI promising an autopilot the worker then refuses to run is
// the exact failure this pair exists to prevent.

function readyUser(profileOverrides: Record<string, unknown> = {}, userOverrides = {}) {
  return {
    name: "A B",
    email: "a@b.com",
    profile: {
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
      ...profileOverrides,
    },
    ...userOverrides,
  };
}

describe("computeReadiness", () => {
  it("passes a fully set up user", () => {
    const r = computeReadiness(readyUser());
    expect(r.ready).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("fails without a resume — nothing truthful to send", () => {
    const r = computeReadiness(readyUser({ resumeName: null }));
    expect(r.ready).toBe(false);
    expect(r.checks.resume).toBe(false);
    expect(r.missing[0]).toMatch(/resume/i);
  });

  it("fails without a phone, which forms ask for on nearly every submission", () => {
    expect(computeReadiness(readyUser({ phone: null })).checks.contact).toBe(false);
  });

  it("fails without graduation year — screening always asks", () => {
    expect(computeReadiness(readyUser({ gradYear: null })).checks.education).toBe(false);
  });

  it("fails with no target domain, so discovery has no direction", () => {
    expect(computeReadiness(readyUser({ preferredDomains: "[]" })).checks.preferences).toBe(false);
  });

  it("treats unparseable preferences as none rather than good enough", () => {
    expect(computeReadiness(readyUser({ preferredDomains: "{oops" })).checks.preferences).toBe(false);
  });

  it("does not carry consent from older wording to new", () => {
    const r = computeReadiness(readyUser({ consentVersion: "2020-01-01" }));
    expect(r.checks.consent).toBe(false);
    expect(r.ready).toBe(false);
  });

  it("lets the toggle revoke a stamped consent", () => {
    expect(computeReadiness(readyUser({ autoApply: false })).checks.consent).toBe(false);
  });

  it("fails closed when there is no profile at all", () => {
    const r = computeReadiness({ name: "A", email: "a@b.com", profile: null });
    expect(r.ready).toBe(false);
    expect(r.missing.length).toBeGreaterThanOrEqual(5);
  });

  it("reports every failure at once so the checklist is actionable", () => {
    const r = computeReadiness(
      readyUser({ resumeName: null, phone: null, gradYear: null, autoApply: false }),
    );
    expect(r.missing.length).toBe(4);
  });
});

describe("education, after setup split it into two boxes", () => {
  // Setup collects degree and college separately now (forms ask for them
  // separately) and nothing writes the combined `education` line directly any
  // more. Checking only the combined field would have refused auto-apply to
  // every user who filled in the new form.
  const base = {
    name: "Ankit Jain",
    email: "ankit@x.com",
    profile: {
      resumeName: "cv.pdf", phone: "9000000011",
      education: null as string | null, degree: null as string | null, college: null as string | null,
      gradYear: 2027, preferredDomains: '["Web Development"]',
      autoApply: true, autoApplyConsentAt: new Date(), consentVersion: CONSENT_VERSION,
      maxPerDay: 5, timezone: "Asia/Kolkata",
    },
  };

  it("accepts the two halves on their own", () => {
    const r = computeReadiness({
      ...base,
      profile: { ...base.profile, degree: "B.Tech in CS", college: "VIT Vellore" },
    });
    expect(r.checks.education).toBe(true);
  });

  it("still accepts the old combined line", () => {
    const r = computeReadiness({
      ...base,
      profile: { ...base.profile, education: "B.Tech CSE, VIT Vellore" },
    });
    expect(r.checks.education).toBe(true);
  });

  it("refuses a half-filled education, which is a fact it would have to state", () => {
    const r = computeReadiness({ ...base, profile: { ...base.profile, degree: "B.Tech in CS" } });
    expect(r.checks.education).toBe(false);
  });

  it("still needs the graduation year whichever shape the rest arrives in", () => {
    const r = computeReadiness({
      ...base,
      profile: { ...base.profile, degree: "B.Tech", college: "VIT", gradYear: null },
    });
    expect(r.checks.education).toBe(false);
  });
});

/**
 * The daily limit is an OPTIONAL narrowing of the plan's allowance, not a fact
 * the user must supply. It was a readiness gate for as long as it was also
 * uneditable — so making it a real setting meant an unset column stopped being
 * a reason to hold every application. worker._cap_for reads 0 the same way:
 * "use whatever my plan allows".
 */
describe("daily limit is optional", () => {
  it("stays ready when the user has never set one", () => {
    const r = computeReadiness(readyUser({ maxPerDay: 0 }));
    expect(r.ready).toBe(true);
    expect(r.checks.dailyLimit).toBe(true);
  });

  it("stays ready when the column is absent entirely", () => {
    const r = computeReadiness(readyUser({ maxPerDay: undefined }));
    expect(r.ready).toBe(true);
  });

  it("still requires a timezone — it decides which day a slot is counted against", () => {
    const r = computeReadiness(readyUser({ timezone: null }));
    expect(r.ready).toBe(false);
    expect(r.checks.dailyLimit).toBe(false);
    expect(r.missing.join(" ")).toMatch(/timezone/i);
  });
});
