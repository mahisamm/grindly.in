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


def skills_claimed(tailored_text: str, master_skills: list[str]) -> list[str]:
    """Which of the candidate's real skills the tailored resume surfaces — used
    for the immutable per-application 'what we presented' record."""
    low = (tailored_text or "").lower()
    return [s for s in (master_skills or []) if s and s.lower() in low]
