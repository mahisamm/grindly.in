import json

import safety
import internshala


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
    recognise. Turning Tier B on must not widen the blast radius by one board.

    The four Tier C adapters (linkedin/naukri/unstop/indeed) were deleted once
    the production pool showed they had contributed zero listings each. The
    POLICY they were guarded by has to outlive them: those names can still reach
    the agent as the `source` on an older row, or as a host that turned up in a
    web search, and the answer must still be "not from our servers". A source we
    have never heard of is refused for exactly the same reason.
    """
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    for source in ("linkedin", "naukri", "unstop", "indeed", "future_source", None):
        required, reason = safety.requires_manual_final_submit(source)
        assert required is True, source
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


# ─── detect_challenge ────────────────────────────────────────────────────

class _FakeChallengePage:
    """Fake Playwright page for detect_challenge: `widgets` maps a selector to
    the bounding box its element is drawn at (None = not visible)."""

    def __init__(self, widgets: dict | None = None, title: str = "Careers",
                 body: str = "Apply for this job"):
        self.widgets = widgets or {}
        self._title = title
        self._body = body

    def query_selector(self, sel):
        if sel not in self.widgets:
            return None
        box = self.widgets[sel]

        class _El:
            def is_visible(self):
                return box is not None

            def bounding_box(self):
                return box

        return _El()

    def title(self):
        return self._title

    def inner_text(self, _sel):
        return self._body


def test_detect_challenge_ignores_an_invisible_recaptcha_script():
    """The regression this was written for: every Greenhouse/Lever/Ashby apply
    page loads recaptcha/api.js as an invisible spam control. Reading the HTML
    source for the word "recaptcha" refused seven of eight real applications."""
    page = _FakeChallengePage(
        body="Apply for this job. This site is protected by reCAPTCHA and the "
             "Google Privacy Policy and Terms of Service apply.",
    )
    assert safety.detect_challenge(page) is None


def test_detect_challenge_ignores_the_invisible_recaptcha_badge():
    # The corner badge injects a real, visible anchor iframe — ~70px wide, and
    # nobody is being asked anything.
    page = _FakeChallengePage(
        {"iframe[src*='recaptcha/api2/anchor']": {"width": 70, "height": 60}}
    )
    assert safety.detect_challenge(page) is None


def test_detect_challenge_catches_a_drawn_checkbox_widget():
    page = _FakeChallengePage(
        {"iframe[src*='recaptcha/api2/anchor']": {"width": 304, "height": 78}}
    )
    assert safety.detect_challenge(page) == safety.FAILURE_REASON.CAPTCHA


def test_detect_challenge_catches_a_cloudflare_interstitial():
    page = _FakeChallengePage(title="Just a moment...")
    assert safety.detect_challenge(page) == safety.FAILURE_REASON.CAPTCHA


def test_detect_challenge_catches_challenge_wording_in_rendered_text():
    page = _FakeChallengePage(body="Verify you are human to continue")
    assert safety.detect_challenge(page) == safety.FAILURE_REASON.CAPTCHA


def test_detect_challenge_survives_a_page_that_raises():
    class _Broken:
        def query_selector(self, _sel):
            raise RuntimeError("detached")

        def title(self):
            raise RuntimeError("detached")

        def inner_text(self, _sel):
            raise RuntimeError("detached")

    assert safety.detect_challenge(_Broken()) is None


def test_classify_submit_tolerates_query_selector_raising():
    class _RaisingPage:
        def query_selector(self, sel):
            raise RuntimeError("detached frame")
    status, reason = safety.classify_submit(_RaisingPage(), [":text('Thank you')"])
    assert status == safety.APPLY_STATUS.NEEDS_REVIEW
