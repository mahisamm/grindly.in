"""Autopilot readiness — the agent-side mirror of src/lib/readiness.ts.

Same question, same answer, enforced twice on purpose. The web checks readiness
so the UI never offers an autopilot that will not run; the worker checks it
again immediately before dispatch, because the facts can change between the two
(consent revoked, resume deleted, the consent wording bumped) and only the
second check is the one that actually protects the user.

Keep CONSENT_VERSION in step with src/lib/readiness.ts. Bumping it un-readies
every account that agreed to older wording: consent to v1 is not consent to v2.
"""
from __future__ import annotations
import json

CONSENT_VERSION = "2026-07-25"


def _has_domain(raw) -> bool:
    if isinstance(raw, list):
        return len(raw) > 0
    try:
        return len(json.loads(raw or "[]")) > 0
    except (TypeError, ValueError):
        return False


def check(user: dict) -> tuple[bool, list[str]]:
    """(ready, missing) for one user row (with its `profile` dict attached).

    `missing` names the failed gates for the run log, so an operator reading
    "held: consent" never has to guess which of six things was absent.
    """
    profile = user.get("profile") or {}
    missing: list[str] = []

    if not profile.get("resume_name"):
        missing.append("resume")
    if not (user.get("name") and user.get("email") and profile.get("phone")):
        missing.append("contact")
    if not (profile.get("education") and profile.get("grad_year")):
        missing.append("education")
    if not _has_domain(profile.get("preferred_domains")):
        missing.append("preferences")
    # No max_per_day gate. It is an OPTIONAL narrowing of the plan's allowance
    # (worker._cap_for), and 0 means "never set". Requiring >= 1 turned an unset
    # column into a reason to hold every application for an account whose plan
    # already supplies a limit. Keep in step with src/lib/readiness.ts.
    # Consent must be present, CURRENT, and still switched on. An old consent
    # does not cover new wording; a stamped consent with the toggle off means
    # "I agreed once, but stop now" — and stop wins.
    if not (
        profile.get("auto_apply_consent_at")
        and profile.get("consent_version") == CONSENT_VERSION
        and profile.get("auto_apply")
    ):
        missing.append("consent")

    return (not missing), missing
