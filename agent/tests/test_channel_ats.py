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


# ── Embedded forms ──────────────────────────────────────────────────────────

class _FramePage:
    """Minimal page stub: query_selector_all("iframe") returns these srcs."""

    def __init__(self, *srcs: str):
        self.srcs = srcs

    def query_selector_all(self, _sel):
        class _El:
            def __init__(self, src):
                self.src = src

            def get_attribute(self, name):
                return self.src if name == "src" else None

        return [_El(s) for s in self.srcs]


@pytest.mark.parametrize("src", [
    "https://boards.greenhouse.io/embed/job_app?token=1",
    "https://jobs.lever.co/acme/abc-123",
    "https://jobs.ashbyhq.com/acme/abc-123/application",
])
def test_an_embedded_ats_form_is_found_by_its_frame_host(src):
    """Employers embed the ATS form in their own careers page. The form is
    perfectly fillable — it is just in another document, and every selector in
    this module queries the top frame only."""
    assert channel_ats._embedded_form_url(_FramePage(src)) == src


def test_a_page_with_no_embedded_form_reports_none():
    assert channel_ats._embedded_form_url(_FramePage()) == ""


def test_an_iframe_that_merely_mentions_the_vendor_is_not_the_form():
    """The regression this exists for: Google's proxy iframe carries the parent
    origin in its query string, so a `src*='greenhouse.io'` match navigated off
    the real application form on every Greenhouse page. Nine of fourteen dry
    runs went from submit-ready to "could not find the form"."""
    page = _FramePage(
        "https://content.googleapis.com/static/proxy.html?jsh=m%3B&"
        "origin=https%3A%2F%2Fjob-boards.greenhouse.io"
    )
    assert channel_ats._embedded_form_url(page) == ""


def test_a_relative_iframe_src_is_ignored():
    # Navigating to "/embed/form" would leave the site entirely.
    assert channel_ats._embedded_form_url(_FramePage("/embed/job_app")) == ""


@pytest.mark.parametrize("url,vendor,expected", [
    ("https://jobs.lever.co/acme/abc-123", "lever",
     "https://jobs.lever.co/acme/abc-123/apply"),
    ("https://jobs.ashbyhq.com/acme/abc-123", "ashby",
     "https://jobs.ashbyhq.com/acme/abc-123/application"),
    ("https://apply.workable.com/acme/j/ABC123", "workable",
     "https://apply.workable.com/acme/j/ABC123/apply"),
    # Greenhouse renders the form under the description — there is nowhere else
    # to go, and guessing a path would navigate off a working form.
    ("https://job-boards.greenhouse.io/acme/jobs/1", "greenhouse", ""),
    # Already there.
    ("https://jobs.lever.co/acme/abc-123/apply", "lever", ""),
])
def test_the_vendors_own_apply_address(url, vendor, expected):
    assert channel_ats._apply_url_for(url, vendor) == expected


# ── Vendor confirmation signals ─────────────────────────────────────────────

@pytest.mark.parametrize("vendor", ["greenhouse", "lever", "ashby",
                                    "smartrecruiters", "workable"])
def test_every_vendor_we_poll_has_its_own_success_signal(vendor):
    """A submit that WORKED coming back as needs_review is the worst outcome in
    the system: the slot and the idempotency claim stay spent, and the user is
    sent to check an application that is already filed."""
    assert channel_ats.vendor_success_selectors(vendor)


def test_an_unknown_vendor_has_no_signal_rather_than_a_wrong_one():
    assert channel_ats.vendor_success_selectors("mystery-ats") == []


def test_a_vendor_confirmation_url_only_counts_for_that_vendor():
    class _P:
        url = "https://jobs.lever.co/acme/abc-123/thanks"

    assert channel_ats._confirmed_by_url(_P(), "lever")
    assert not channel_ats._confirmed_by_url(_P(), "workable")


# ── Whose problem is it? ────────────────────────────────────────────────────
# A live run refused three real employer forms in a row — on "Date of Birth *",
# "Expected Salary *" and "Graduation Month & Year *". Every one is a fact only
# the user can state, and the reason on their dashboard quoted the employer's
# asterisks back at them, which reads as a broken agent rather than as one edit
# they could make once and never again.

def test_a_blocking_question_is_named_as_the_setup_field():
    gaps = channel_ats._blocking_facts(["Date of Birth *", "Expected Salary *"], {})
    assert gaps == ["your date of birth", "the stipend you expect"]


def test_a_fact_the_user_has_given_does_not_block():
    gaps = channel_ats._blocking_facts(
        ["Date of Birth *"], {"date_of_birth": "14/03/2005"}
    )
    assert gaps == []


def test_a_question_setup_never_asked_is_not_blamed_on_the_user():
    """That one is the agent's own to fix — a form it could not read. Reporting
    it as a setup gap would send someone hunting for a box that does not
    exist."""
    assert channel_ats._blocking_facts(["Describe a time you shipped something"], {}) == []


def test_the_same_fact_is_named_once_however_many_forms_ask():
    gaps = channel_ats._blocking_facts(["Date of birth", "D.O.B *"], {})
    assert gaps == ["your date of birth"]


def test_every_named_fact_reads_as_something_a_person_would_fill():
    for key, said in channel_ats._FACT_LABELS.items():
        assert said and said == said.lower() or said.startswith("your"), key
        assert "_" not in said, key
