// Autopilot readiness — the one answer to "may the agent act for this user?".
//
// Activation (api/trial/activate), the dashboard checklist, and the worker's
// pre-send gate all call this same function, so "ready" can never mean three
// different things. The rule it enforces: the agent submits applications under
// a user's name only when it holds every fact it will be asked to state, and
// an explicit, current consent to state them.
//
// Consent is versioned. CONSENT_VERSION names the wording the user agreed to;
// bumping it (because the promise itself changed) un-readies every account on
// older wording until they re-agree. Agreement to v1 is not agreement to v2.

export const CONSENT_VERSION = "2026-07-25";

export const CONSENT_TEXT =
  "I authorize Grindly to submit internship applications on my behalf using " +
  "the facts I provided. Grindly will pause and ask me instead of guessing " +
  "whenever an application needs something I haven't approved — it never " +
  "invents grades, eligibility, or personal details. I can revoke this any " +
  "time by turning auto-apply off, which stops all automatic submissions.";

type ReadinessProfile = {
  resumeName: string | null;
  phone: string | null;
  education: string | null;
  degree?: string | null;
  college?: string | null;
  gradYear: number | null;
  preferredDomains: string;
  autoApply: boolean;
  autoApplyConsentAt: Date | null;
  consentVersion: string | null;
  maxPerDay: number;
  timezone: string;
} | null;

type ReadinessUser = {
  name: string | null;
  email: string;
  profile: ReadinessProfile;
};

export type Readiness = {
  ready: boolean;
  /** Every gate, individually, so the UI can show a checklist instead of a shrug. */
  checks: {
    resume: boolean;
    contact: boolean;
    education: boolean;
    preferences: boolean;
    dailyLimit: boolean;
    consent: boolean;
  };
  /** Human sentences for whatever is missing, in fix-this order. */
  missing: string[];
};

export function computeReadiness(user: ReadinessUser): Readiness {
  const p = user.profile;
  const checks = {
    // The resume is what every match is scored against and what recruiters
    // receive — without it the agent has nothing truthful to send.
    resume: !!p?.resumeName,
    // Forms ask for a name + reachable contact on virtually every submission.
    contact: !!user.name && !!user.email && !!p?.phone,
    // Education + graduation timing are the facts intern screening always asks.
    // `education` is the combined "course and college" line; setup now collects
    // the two halves separately (forms ask for them in separate boxes) and the
    // API composes the line from them. Either shape satisfies this — checking
    // only the composed field would have locked out every user who filled in the
    // new form, since nothing writes it directly any more.
    education: (!!p?.education || (!!p?.degree && !!p?.college)) && !!p?.gradYear,
    // At least one target domain, or discovery has no direction to search in.
    preferences: (() => {
      try {
        return (JSON.parse(p?.preferredDomains || "[]") as unknown[]).length > 0;
      } catch {
        return false;
      }
    })(),
    dailyLimit: (p?.maxPerDay ?? 0) >= 1 && !!p?.timezone,
    // Current-version consent AND the toggle presently on. Either alone is not
    // enough: an old consent doesn't cover new wording, and consent with the
    // toggle off means "I agreed once, but stop for now".
    consent:
      !!p?.autoApplyConsentAt &&
      p?.consentVersion === CONSENT_VERSION &&
      !!p?.autoApply,
  };

  const missing: string[] = [];
  if (!checks.resume) missing.push("Upload your resume.");
  // checks.contact bundles three facts into one boolean (kept as-is — other
  // code reads .checks.contact as a single gate), but the message must name
  // whichever of them is actually absent. Collapsing all three into "add your
  // phone number" meant a user with no `name` (Google didn't return one, and
  // nothing in the app could ever set it) saw that same message forever, even
  // after adding a phone — there was nothing left telling them what was
  // actually still missing.
  if (!checks.contact) {
    if (!user.name) missing.push("Add your name.");
    if (!p?.phone) missing.push("Add your phone number so forms can be completed.");
  }
  if (!checks.education) missing.push("Add your education and expected graduation year.");
  if (!checks.preferences) missing.push("Pick at least one target domain.");
  if (!checks.dailyLimit) missing.push("Set a daily application limit and timezone.");
  if (!checks.consent) missing.push("Review and accept the auto-apply consent.");

  return { ready: Object.values(checks).every(Boolean), checks, missing };
}
