// Single source of truth for application lifecycle + failure taxonomy.
// Mirrored on the Python side in agent/safety.py — keep both in sync.

export const APPLY_STATUS = {
  MATCHED: "matched", // scored above threshold, awaiting user preparation
  APPROVED: "approved", // ready for the user's final browser submission
  SUBMITTING: "submitting", // set BEFORE the click; in-flight, outcome unknown
  APPLIED: "applied", // confirmed submitted (success signal seen)
  SKIPPED: "skipped", // intentionally not applied (firewall, dup, below score)
  FAILED: "failed", // attempted, did not succeed
  NEEDS_REVIEW: "needs_review", // ambiguous (timeout mid-submit, custom Qs) — human must decide
} as const;

export type ApplyStatus = (typeof APPLY_STATUS)[keyof typeof APPLY_STATUS];

// Enumerated machine reason for a non-success outcome. Drives user-facing
// copy ("3 skipped: listings closed") and triage, instead of opaque strings.
export const FAILURE_REASON = {
  SESSION_EXPIRED: "session_expired",
  SELECTOR_MISSING: "selector_missing",
  CAPTCHA: "captcha",
  LISTING_CLOSED: "listing_closed",
  UPLOAD_FAILED: "upload_failed",
  FIREWALL_BLOCKED: "firewall_blocked",
  CUSTOM_QUESTIONS: "custom_questions",
  TIMEOUT: "timeout",
  EXCEPTION: "exception",
} as const;

export type FailureReason = (typeof FAILURE_REASON)[keyof typeof FAILURE_REASON];

const HUMAN: Record<string, string> = {
  session_expired: "Platform session expired — reconnect needed",
  selector_missing: "Platform page changed — agent couldn't find the form",
  captcha: "Blocked by a CAPTCHA / human check",
  listing_closed: "Listing was closed before we could apply",
  upload_failed: "Resume upload was rejected",
  firewall_blocked: "Blocked by your limits & rules",
  custom_questions: "Listing asked questions we won't answer for you",
  timeout: "Timed out mid-submit — outcome unconfirmed",
  exception: "Unexpected error during apply",
};

export function humanFailure(reason?: string | null): string {
  if (!reason) return "Unknown reason";
  return HUMAN[reason] ?? reason;
}

// An outcome that left the application in an unconfirmed state. Such rows must
// never be reported as `applied` — surface them for human review instead.
export function isUnconfirmed(reason?: string | null): boolean {
  return reason === FAILURE_REASON.TIMEOUT || reason === FAILURE_REASON.SESSION_EXPIRED;
}
