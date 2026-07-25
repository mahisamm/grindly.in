"""agent/readiness.py — the gate that decides whether the agent may act.

Everything here is about one promise: the agent submits under a user's name only
when it holds every fact it will be asked to state, and a current consent to
state them. Failing closed is the whole point, so most of these tests assert a
refusal.
"""
import pytest

import readiness
import worker


def _ready_user(**overrides):
    profile = {
        "resume_name": "resume.pdf",
        "phone": "+919000000000",
        "education": "B.Tech CSE",
        "grad_year": 2027,
        "preferred_domains": '["web development"]',
        "max_per_day": 5,
        "auto_apply": True,
        "auto_apply_consent_at": "2026-07-25T00:00:00",
        "consent_version": readiness.CONSENT_VERSION,
    }
    profile.update(overrides.pop("profile", {}))
    user = {"name": "A B", "email": "a@b.com", "profile": profile}
    user.update(overrides)
    return user


def test_a_fully_set_up_user_is_ready():
    ready, missing = readiness.check(_ready_user())
    assert ready is True and missing == []


@pytest.mark.parametrize("field,gate", [
    ("resume_name", "resume"),
    ("phone", "contact"),
    ("education", "education"),
    ("grad_year", "education"),
])
def test_each_missing_fact_names_its_own_gate(field, gate):
    ready, missing = readiness.check(_ready_user(profile={field: None}))
    assert ready is False and gate in missing


def test_no_target_domain_is_not_ready():
    ready, missing = readiness.check(_ready_user(profile={"preferred_domains": "[]"}))
    assert ready is False and "preferences" in missing


def test_a_corrupt_domains_value_fails_closed():
    """Unparseable preferences must read as none, not as 'good enough'."""
    ready, missing = readiness.check(_ready_user(profile={"preferred_domains": "{oops"}))
    assert ready is False and "preferences" in missing


# ---- consent: the gate with three separate ways to fail ---------------------

def test_consent_never_given_is_not_ready():
    ready, missing = readiness.check(_ready_user(profile={"auto_apply_consent_at": None}))
    assert ready is False and "consent" in missing


def test_consent_to_older_wording_does_not_carry_over():
    """Bumping CONSENT_VERSION is how we say "the promise changed". An account
    that agreed to the old text has not agreed to the new one."""
    ready, missing = readiness.check(_ready_user(profile={"consent_version": "2020-01-01"}))
    assert ready is False and "consent" in missing


def test_revoking_the_toggle_beats_a_stamped_consent():
    """Consent stamped + toggle off means "I agreed once, but stop now"."""
    ready, missing = readiness.check(_ready_user(profile={"auto_apply": False}))
    assert ready is False and "consent" in missing


def test_a_user_row_with_no_profile_at_all_is_not_ready():
    ready, missing = readiness.check({"name": "A", "email": "a@b.com"})
    assert ready is False
    assert {"resume", "contact", "education", "preferences", "consent"} <= set(missing)


# ---- the worker plan carries the verdict ------------------------------------

def test_build_plan_marks_a_ready_user_ready():
    u = _ready_user()
    plan = worker.build_plan(u["profile"], ["python"], 5, u)
    assert plan["ready"] is True and plan["not_ready"] == []


def test_build_plan_without_the_user_row_fails_closed():
    """Older call sites pass no user. Readiness must then refuse rather than
    assume — a run that cannot prove readiness prepares instead of sending."""
    plan = worker.build_plan(_ready_user()["profile"], ["python"], 5)
    assert plan["ready"] is False and "contact" in plan["not_ready"]
