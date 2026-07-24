import json

import safety
import indeed
import internshala
import linkedin
import naukri
import unstop


def test_can_apply_blocks_firewall():
    job = {"company": "Acme", "location": "Remote"}
    profile = {"excluded_companies": json.dumps(["Acme"]), "min_match_score": 50}
    ok, reason = safety.can_apply(job, profile, score=90)
    assert ok is False
    assert reason


def test_can_apply_blocks_low_score():
    job = {"company": "GoodCo", "location": "Remote"}
    profile = {"excluded_companies": "[]", "min_match_score": 55}
    ok, reason = safety.can_apply(job, profile, score=40)
    assert ok is False


def test_can_apply_allows_good_job():
    job = {"company": "GoodCo", "location": "Remote"}
    profile = {"excluded_companies": "[]", "min_match_score": 55, "work_mode": "any"}
    ok, reason = safety.can_apply(job, profile, score=80)
    assert ok is True
    assert reason is None


def test_tier_c_and_unknown_sources_require_a_manual_final_submit(monkeypatch):
    """No combination of switches releases a Tier C board, or a source we do not
    recognise. Turning Tier B on must not widen the blast radius by one board."""
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    for source in ("linkedin", "naukri", "unstop", "indeed", "future_source", None):
        required, reason = safety.requires_manual_final_submit(source)
        assert required is True, source
        assert "own browser" in reason


def test_tier_c_adapters_fail_closed_before_opening_a_submit_form(monkeypatch):
    """The four Tier C adapters must refuse before they touch a browser, even
    with every switch on.

    internshala is deliberately absent: it is Tier B, and with both switches on
    it is *supposed* to proceed — which would launch a real browser, so its
    permitted path belongs in the policy tests, not here.
    """
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    job = {"url": "https://example.test/job"}
    for adapter in (linkedin, naukri, unstop, indeed):
        status, reason = adapter.apply(job, "", "test-user")
        assert status == safety.APPLY_STATUS.NEEDS_REVIEW
        assert "own browser" in reason


def test_internshala_fails_closed_while_tier_b_is_off(monkeypatch):
    """With the switches off the Tier B adapter refuses before opening a browser
    too. The gate is what stops it — not the happy accident of a missing
    session, which is what would be left if the gate were removed."""
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "shadow")
    monkeypatch.delenv("GRINDLY_TIER_B_APPLY", raising=False)
    status, reason = internshala.apply({"url": "https://example.test/job"}, "", "test-user")
    assert status == safety.APPLY_STATUS.NEEDS_REVIEW
    assert "prepared the application" in reason


def test_session_ok_detects_login_url():
    class FakePage:
        url = "https://www.linkedin.com/login"
    assert safety.session_ok(FakePage()) is False


def test_session_ok_passes_normal_url():
    class FakePage:
        url = "https://www.linkedin.com/jobs"
    assert safety.session_ok(FakePage()) is True


def test_skills_claimed_subset_of_master():
    claimed = safety.skills_claimed("Skilled in React and Python", ["react", "python", "rust"])
    assert "react" in claimed and "python" in claimed
    assert "rust" not in claimed


# ─── classify_submit ─────────────────────────────────────────────────────

class _FakeSelectablePage:
    """Fake Playwright page: query_selector(sel) returns a truthy stub only for
    selectors listed in `hits`, mimicking a real DOM match/no-match."""
    def __init__(self, hits: set[str]):
        self.hits = hits

    def query_selector(self, sel):
        return object() if sel in self.hits else None


def test_classify_submit_returns_applied_on_success_selector():
    page = _FakeSelectablePage({":text('Thank you')"})
    status, reason = safety.classify_submit(page, [":text('Application sent')", ":text('Thank you')"])
    assert status == safety.APPLY_STATUS.APPLIED
    assert "confirmation detected" in reason


def test_classify_submit_returns_failed_on_error_selector():
    page = _FakeSelectablePage({":text('required')"})
    status, reason = safety.classify_submit(page, [":text('Thank you')"])
    assert status == safety.APPLY_STATUS.FAILED
    assert "validation" in reason or "error" in reason


def test_classify_submit_returns_needs_review_when_ambiguous():
    page = _FakeSelectablePage(set())  # neither success nor error text present
    status, reason = safety.classify_submit(page, [":text('Thank you')"])
    assert status == safety.APPLY_STATUS.NEEDS_REVIEW
    assert "not detected" in reason


def test_classify_submit_success_checked_before_error():
    # If a page somehow matches both (e.g. a stray "required" label elsewhere
    # on a genuinely successful confirmation page), success wins — it's the
    # stronger, more specific signal.
    page = _FakeSelectablePage({":text('Thank you')", ":text('required')"})
    status, _ = safety.classify_submit(page, [":text('Thank you')"])
    assert status == safety.APPLY_STATUS.APPLIED


def test_classify_submit_tolerates_query_selector_raising():
    class _RaisingPage:
        def query_selector(self, sel):
            raise RuntimeError("detached frame")
    status, reason = safety.classify_submit(_RaisingPage(), [":text('Thank you')"])
    assert status == safety.APPLY_STATUS.NEEDS_REVIEW
