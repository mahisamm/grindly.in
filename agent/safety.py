"""Agent-side safety helpers — session checks, apply state/failure taxonomy,
proof screenshots, and the hard firewall gate.

Mirrors the TS side:
  * FAILURE_REASON / APPLY_STATUS  <-> src/lib/applyState.ts
  * can_apply                      <-> src/lib/firewall.ts (via matcher.firewall_block)

Platform adapters (linkedin.py, internshala.py, ...) should:
  1. call session_ok(page) right after navigating, before touching any form;
     return ("login_required", FAILURE_REASON.SESSION_EXPIRED) if it fails.
  2. set status SUBMITTING conceptually before the final click, and only return
     ("applied", ...) after a confirmed success signal.
  3. on any handled failure, return (status, reason_code) so the worker can store
     a clean failure_reason instead of an opaque string.
"""
from __future__ import annotations
import os
import re
import time

import matcher


class APPLY_STATUS:
    MATCHED = "matched"
    APPROVED = "approved"
    SUBMITTING = "submitting"
    APPLIED = "applied"
    SKIPPED = "skipped"
    FAILED = "failed"
    NEEDS_REVIEW = "needs_review"


class FAILURE_REASON:
    SESSION_EXPIRED = "session_expired"
    SELECTOR_MISSING = "selector_missing"
    CAPTCHA = "captcha"
    LISTING_CLOSED = "listing_closed"
    UPLOAD_FAILED = "upload_failed"
    FIREWALL_BLOCKED = "firewall_blocked"
    CUSTOM_QUESTIONS = "custom_questions"
    TIMEOUT = "timeout"
    EXCEPTION = "exception"


_LOGIN_URL_HINTS = ("login", "signin", "sign-in", "/account/login", "authwall")
_CAPTCHA_HINTS = ("captcha", "are you a human", "verify you", "recaptcha", "hcaptcha")

# Safe Apply Mode is the fallback answer, not the only one.  It is what a user
# sees whenever policy cannot say yes: auto-apply switched off, an unknown tier,
# or a destination with no sender behind it.  Keeping it as one string gives the
# worker and every adapter a single sentence for "we prepared this, you send it".
SAFE_APPLY_REASON = (
    "Safe Apply Mode: open this application in your own browser and complete "
    "the final submission yourself."
)


# ── Destination policy ──────────────────────────────────────────────────────
#
# The old model had one question: "may we submit on <platform>?", and one
# answer: no.  That conflated two different risks under one boolean.  The real
# variable is not which board found the listing, it is *where the application
# is delivered*, because ban risk requires a bannable account:
#
#   Tier A  employer's own intake (Google Form / HR mailbox / ATS portal).
#           The candidate has no account there; the form exists to receive
#           applications from strangers.  Unattended submit is safe.
#   Tier B  a board where the user explicitly handed us credentials through the
#           hosted-login consent flow.  Permitted only when switched on, and
#           only under the worker's per-platform pacing caps.
#   Tier C  a board holding an account the user cannot afford to lose.  Never
#           submitted from our servers, at any setting.  This is the browser
#           extension's job — the user's own session, device and IP.
#
# See agent/resolver.py for how a listing is mapped to a tier.

# off    — resolve nothing, behave exactly as before this module existed.
# shadow — resolve and record every destination, submit nothing.  This is how
#          the Tier A coverage rate gets measured before anything is promised
#          to a user.  Default, because a number nobody has measured is not a
#          basis for sending mail in someone's name.
# live   — Tier A destinations submit unattended.
AUTO_APPLY_OFF = "off"
AUTO_APPLY_SHADOW = "shadow"
AUTO_APPLY_LIVE = "live"

TIER_A_HOLD_REASON = (
    "Auto-apply is in shadow mode: destination resolved but nothing was sent."
)
TIER_B_HOLD_REASON = (
    "This board holds your account, so the agent prepared the application "
    "instead of sending it. Approve it and the agent submits."
)
TIER_C_HOLD_REASON = (
    "This platform is never submitted from Grindly's servers — open it in your "
    "own browser to send it."
)


def auto_apply_mode() -> str:
    """Fleet-wide auto-apply switch, from GRINDLY_AUTO_APPLY_MODE.

    Fails closed: anything unrecognised (including a typo in the env var) reads
    as shadow, never as live.  A misconfigured deploy must not start sending
    applications under a user's name.
    """
    mode = (os.environ.get("GRINDLY_AUTO_APPLY_MODE") or AUTO_APPLY_SHADOW).strip().lower()
    return mode if mode in (AUTO_APPLY_OFF, AUTO_APPLY_SHADOW, AUTO_APPLY_LIVE) else AUTO_APPLY_SHADOW


def tier_b_enabled() -> bool:
    """Tier B (hosted submit on a board the user gave credentials to) is a
    separate switch from `live`.  Turning Tier A on must never silently turn on
    the one path that can cost a user their account."""
    return os.environ.get("GRINDLY_TIER_B_APPLY") == "1"


def requires_manual_final_submit(source: str | None = None) -> tuple[bool, str]:
    """Must a human perform the final submit on this *board*? -> (yes, reason).

    The answer is the board's tier, never the board's name.  `platform_tier`
    owns that mapping, so this function and `destination_policy` below cannot
    drift apart into two different opinions about the same listing:

      Tier B  the user handed us credentials through the hosted-login consent
              flow, so submitting there is the thing they asked us to do.
              Allowed when the fleet is live AND Tier B is separately switched
              on — both, because turning Tier A on must never silently start
              submitting under someone's account.
      Tier C  an account the user cannot afford to lose, on a board that fights
              automation.  Never submitted from our servers, at any setting.

    Unknown sources fall to Tier C by construction (see `platform_tier`), so a
    new adapter still never inherits unattended submission by accident.

    This governs the board channel only.  Applications routed to an employer's
    own intake — Google Form, HR mailbox, ATS portal — never reach a platform
    adapter and are governed by `destination_policy()` below instead.
    """
    from resolver import TIER_B, platform_tier  # local: keeps import graph acyclic

    if platform_tier(source or "") != TIER_B:
        return True, TIER_C_HOLD_REASON
    if auto_apply_mode() != AUTO_APPLY_LIVE or not tier_b_enabled():
        return True, TIER_B_HOLD_REASON
    return False, f"auto-apply (hosted): {(source or 'platform').lower()}"


def destination_policy(dest: dict | None) -> tuple[bool, str]:
    """May the worker submit this destination unattended? -> (ok, reason).

    `reason` is written for the user, not for a log line: when ok is False it
    is what the dashboard shows next to the banked application.
    """
    from resolver import TIER_A, TIER_B, TIER_C  # local: keeps import graph acyclic

    if not dest:
        return False, SAFE_APPLY_REASON

    mode = auto_apply_mode()
    if mode == AUTO_APPLY_OFF:
        return False, SAFE_APPLY_REASON

    tier = dest.get("tier")

    if tier == TIER_A:
        if mode != AUTO_APPLY_LIVE:
            return False, TIER_A_HOLD_REASON
        return True, f"auto-apply: {dest.get('evidence') or dest.get('channel')}"

    if tier == TIER_B:
        if mode != AUTO_APPLY_LIVE or not tier_b_enabled():
            return False, TIER_B_HOLD_REASON
        return True, f"auto-apply (hosted): {dest.get('vendor') or 'platform'}"

    if tier == TIER_C:
        return False, TIER_C_HOLD_REASON

    # Unknown tier — treat like an unknown source: no permission by default.
    return False, SAFE_APPLY_REASON


def can_apply(job: dict, profile: dict, score: int | None = None) -> tuple[bool, str | None]:
    """Hard gate — final check before submitting. Returns (ok, reason_if_blocked).

    Combines firewall constraints with the min-match-score floor. The worker
    already checks these separately; this is the single canonical gate adapters
    can also call defensively so nothing applies outside the user's limits.
    """
    block = matcher.firewall_block(job, profile)
    if block:
        return False, f"firewall: {block}"
    min_score = int(profile.get("min_match_score") or 0)
    if score is not None and score < min_score:
        return False, f"score {score} < min {min_score}"
    return True, None


def session_ok(page, authed_selector: str | None = None) -> bool:
    """Best-effort logged-in check. Works with a Playwright page; degrades
    gracefully (returns True) if `page` lacks the expected API so we never block
    on the check itself."""
    try:
        url = (getattr(page, "url", "") or "").lower()
    except Exception:  # noqa: BLE001
        return True
    if any(h in url for h in _LOGIN_URL_HINTS):
        return False
    # if an authed-only selector is provided, require it to be present
    if authed_selector:
        try:
            el = page.query_selector(authed_selector)
            if el is None:
                return False
        except Exception:  # noqa: BLE001
            pass
    return True


def detect_challenge(page) -> str | None:
    """Return FAILURE_REASON.CAPTCHA if a human-check is visibly present, else None."""
    try:
        content = (page.content() or "").lower()
    except Exception:  # noqa: BLE001
        return None
    if any(h in content for h in _CAPTCHA_HINTS):
        return FAILURE_REASON.CAPTCHA
    return None


def screenshot(page, uid: str, key: str, root: str | None = None) -> str | None:
    """Save a proof screenshot of the apply attempt. Returns relative path or None."""
    try:
        base = root or os.path.join(os.path.dirname(__file__), "..", "data", "screenshots", uid)
        os.makedirs(base, exist_ok=True)
        safe = re.sub(r"[^a-z0-9_]+", "_", key.lower())[:48]
        path = os.path.join(base, f"{safe}_{int(time.time())}.png")
        page.screenshot(path=path)
        # store a path relative to the project data dir for the dashboard
        return os.path.relpath(path, os.path.join(os.path.dirname(__file__), ".."))
    except Exception as e:  # noqa: BLE001
        print(f"[safety] screenshot failed: {e}")
        return None


_ERROR_HINTS_DEFAULT = (
    ":text('required')",
    ":text('please fill')",
    ":text('invalid')",
    ":text('something went wrong')",
    "[role='alert']",
    ".error, .form-error, .field-error",
)


def classify_submit(page, success_selectors: list[str]) -> tuple[str, str]:
    """Classify the page right after a Submit click. Never re-clicks anything —
    callers must not retry an ambiguous result, since resubmitting an
    already-accepted form risks a duplicate application.

    Returns (status, reason), status in {applied, needs_review, failed}:
      - a success selector matched              -> applied (confirmed)
      - a validation/error selector matched      -> failed (confirmed rejection)
      - neither matched                          -> needs_review (ambiguous —
        the click registered but we can't confirm the outcome; a human should
        check, and the worker must not silently count this as a success)
    """
    for sel in success_selectors:
        try:
            if page.query_selector(sel):
                return APPLY_STATUS.APPLIED, "submitted — confirmation detected"
        except Exception:  # noqa: BLE001
            pass
    for sel in _ERROR_HINTS_DEFAULT:
        try:
            if page.query_selector(sel):
                return APPLY_STATUS.FAILED, "submit click registered but page shows a validation/error message"
        except Exception:  # noqa: BLE001
            pass
    return APPLY_STATUS.NEEDS_REVIEW, "submitted — confirmation not detected, verify manually"


def skills_claimed(tailored_text: str, master_skills: list[str]) -> list[str]:
    """Which of the candidate's real skills the tailored resume surfaces — used
    for the immutable per-application 'what we presented' record."""
    low = (tailored_text or "").lower()
    return [s for s in (master_skills or []) if s and s.lower() in low]
