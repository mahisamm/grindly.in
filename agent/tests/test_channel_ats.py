"""ATS sender — the parts that must hold without a browser.

Everything here is deliberately hermetic. `apply()` runs three guards before it
imports Playwright at all, and those guards are the ones that matter most: they
are what stops a misconfigured deploy from opening a browser per listing and
filing applications under someone's real name.
"""
import pytest

import channel_ats


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("GRINDLY_ATS_APPLY", raising=False)
    monkeypatch.delenv("GRINDLY_ATS_HEADLESS", raising=False)


def _job():
    return {"url": "https://boards.greenhouse.io/acme/jobs/1", "external_id": "1"}


# ── The switch ──────────────────────────────────────────────────────────────

def test_disabled_by_default(monkeypatch):
    """Fail-closed like every other capability flag. A sender that files real
    applications never turns itself on because some other flag flipped."""
    assert channel_ats.enabled() is False


def test_only_the_exact_string_enables_it(monkeypatch):
    for junk in ("true", "yes", "on", "0", "", "  ", "TRUE"):
        monkeypatch.setenv("GRINDLY_ATS_APPLY", junk)
        assert channel_ats.enabled() is False
    monkeypatch.setenv("GRINDLY_ATS_APPLY", "1")
    assert channel_ats.enabled() is True


def test_headed_by_default_so_the_page_sees_a_real_browser(monkeypatch):
    """This sender faces the strictest bot check of any adapter — a public ATS
    page, no session, datacenter IP — and headless Chromium is trivially
    fingerprinted. The worker container runs Xvfb so headed costs nothing; a
    live Greenhouse page answering with a human-check is what this default
    exists to stop handing them."""
    assert channel_ats._headless() is False
    monkeypatch.setenv("GRINDLY_ATS_HEADLESS", "1")
    assert channel_ats._headless() is True


# ── The guards that run before a browser is ever started ────────────────────

def test_no_target_is_skipped_not_failed():
    status, why = channel_ats.apply({}, "letter", "u1", target="")
    assert status == "skipped"
    assert "no ATS URL" in why


def test_switched_off_holds_without_opening_a_browser(tmp_path):
    resume = tmp_path / "cv.pdf"
    resume.write_bytes(b"%PDF-1.4")
    status, why = channel_ats.apply(
        _job(), "letter", "u1", resume_path=str(resume),
        target="https://boards.greenhouse.io/acme/jobs/1",
    )
    assert status == "needs_review"
    assert "switched off" in why


def test_a_missing_resume_is_reported_as_a_profile_gap(monkeypatch):
    """Not a failure of this listing — it would recur on every ATS application
    until the user uploads one, so the reason has to point at the fix."""
    monkeypatch.setenv("GRINDLY_ATS_APPLY", "1")
    status, why = channel_ats.apply(
        _job(), "letter", "u1", resume_path=None,
        target="https://boards.greenhouse.io/acme/jobs/1",
    )
    assert status == "needs_review"
    assert "resume" in why.lower()


def test_a_resume_path_that_does_not_exist_is_caught(monkeypatch):
    monkeypatch.setenv("GRINDLY_ATS_APPLY", "1")
    status, why = channel_ats.apply(
        _job(), "letter", "u1", resume_path="/nope/missing.pdf",
        target="https://boards.greenhouse.io/acme/jobs/1",
    )
    assert status == "needs_review"
    assert "resume" in why.lower()


# ── Refuse rather than invent ───────────────────────────────────────────────

def test_unanswered_required_questions_are_reported():
    fields = [
        {"kind": "select", "label": "Do you have a work permit?", "required": True},
        {"kind": "text", "label": "Portfolio URL", "required": False},
    ]
    answers = [
        {"_i": 0, "answer": "", "source": "unanswerable"},
        {"_i": 1, "answer": "", "source": "ai"},
    ]
    missing = channel_ats._unanswered_required(fields, answers)
    assert missing == ["Do you have a work permit?"]


def test_an_answered_required_question_is_not_reported():
    fields = [{"kind": "textarea", "label": "Why this role?", "required": True}]
    answers = [{"_i": 0, "answer": "Because ...", "source": "fallback"}]
    assert channel_ats._unanswered_required(fields, answers) == []


def test_whitespace_is_not_an_answer():
    fields = [{"kind": "text", "label": "Notice period", "required": True}]
    answers = [{"_i": 0, "answer": "   ", "source": "ai"}]
    assert channel_ats._unanswered_required(fields, answers) == ["Notice period"]


# ── The cover letter lands in the cover-letter box, and nowhere else ────────

def test_cover_letter_replaces_the_generated_answer():
    fields = [
        {"kind": "text", "label": "Full name", "required": True},
        {"kind": "textarea", "label": "Cover letter", "required": False},
    ]
    answers = [
        {"_i": 0, "answer": "Asha", "source": "profile"},
        {"_i": 1, "answer": "generic paragraph", "source": "ai"},
    ]
    channel_ats._apply_cover_letter(fields, answers, "Tailored letter for Acme.")
    assert answers[0]["answer"] == "Asha"          # untouched
    assert answers[1]["answer"] == "Tailored letter for Acme."
    assert answers[1]["source"] == "cover_letter"


def test_cover_letter_never_overwrites_a_short_text_input():
    """A single-line input labelled "Why?" is not a cover-letter box. Typing 4000
    characters into one is how a real application goes out looking broken."""
    fields = [{"kind": "text", "label": "Why do you want this role?", "required": True}]
    answers = [{"_i": 0, "answer": "kept", "source": "ai"}]
    channel_ats._apply_cover_letter(fields, answers, "Tailored letter.")
    assert answers[0]["answer"] == "kept"


def test_no_cover_letter_leaves_answers_alone():
    fields = [{"kind": "textarea", "label": "Cover letter", "required": False}]
    answers = [{"_i": 0, "answer": "generated", "source": "ai"}]
    channel_ats._apply_cover_letter(fields, answers, "")
    assert answers[0]["answer"] == "generated"


# ── Closed listings are skipped, not failed ─────────────────────────────────

@pytest.mark.parametrize("text", [
    "This job is no longer accepting applications",
    "Position has been closed",
    "This posting is expired",
    "404 page not found",
    "We are not accepting applications at this time",
])
def test_closed_listing_phrasings_are_detected(text):
    assert channel_ats._CLOSED_RE.search(text)


@pytest.mark.parametrize("text", [
    "Apply for this job",
    "Submit your application below",
    "We are accepting applications on a rolling basis",
])
def test_open_listings_are_not_mistaken_for_closed(text):
    assert channel_ats._CLOSED_RE.search(text) is None
