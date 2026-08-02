"""Autopilot readiness — the agent-side mirror of src/lib/readiness.ts.

Same question, same answer, enforced twice on purpose. The web checks readiness
so the UI never offers an autopilot that will not run; the worker checks it
again immediately before dispatch, because the facts can change between the two
(consent revoked, resume deleted, the consent wording bumped) and only the
second check is the one that actually protects the user.

Keep CONSENT_VERSION in step with src/lib/readiness.ts. Bumping it un-readies
every account that agreed to older wording: consent to v1 is not consent to v2.

That instruction was already here and was not enough. On 2026-08-01 the TS
constant was bumped to 2026-08-01 and this one was left at 2026-07-25. The web
then wrote the new version onto the profile, this file compared it against the
old one, and the agent held every run with "setup incomplete: consent" — for a
user whose consent was current and whose auto_apply was on. It found 18
matches, routed 14 of them to real employer forms, and sent none.

Nothing about that was visible from the dashboard: the row said "matched", the
funnel said banked_for_user=18, and the honest-looking explanation was a queue
doing its job. A comment cannot hold two constants together across two
languages, so tests/test_consent_version_matches_the_web.py now reads BOTH
files and fails if they ever disagree again.
"""
from __future__ import annotations
import json

CONSENT_VERSION = "2026-08-01"


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
