"""Google Form channel — read a form, answer it, submit it.

The behaviours that matter here are the refusals. Submitting a half-answered
application under someone's name is worse than not submitting, so anything the
channel cannot answer honestly has to come back as needs_review.
"""
import json

import channel_google_form as gform


def _payload(items):
    """A minimal FB_PUBLIC_LOAD_DATA_ page in the shape parse_form expects."""
    data = [None, [None, items, None, None, None, None, None, None, "Form title"]]
    return (
        "<html><script>var FB_PUBLIC_LOAD_DATA_ = "
        + json.dumps(data)
        + ";</script><input name=\"fbzx\" value=\"-12345\"></html>"
    )


def _item(entry_id, label, qtype, options=None, required=False):
    opts = [[o] for o in (options or [])]
    return [None, label, None, qtype, [[entry_id, opts, 1 if required else 0]]]


# ── Schema parsing ──────────────────────────────────────────────────────────

def test_parses_questions_entry_ids_and_required_flags():
    html = _payload([
        _item(111, "Your name", gform._T_SHORT, required=True),
        _item(222, "Why should we hire you?", gform._T_PARAGRAPH),
        _item(333, "Can you join immediately?", gform._T_RADIO, ["Yes", "No"], required=True),
    ])
    schema = gform.parse_form(html)
    assert [f["entry_id"] for f in schema["fields"]] == [111, 222, 333]
    assert schema["fields"][0]["required"] is True
    assert schema["fields"][2]["options"] == ["Yes", "No"]


def test_a_page_with_no_schema_is_unreadable_not_empty():
    """A sign-in wall or a changed payload must never read as 'no questions' —
    that would submit an empty response."""
    assert gform.parse_form("<html>Sign in to continue</html>") is None
    assert gform.parse_form("var FB_PUBLIC_LOAD_DATA_ = not-json;</script>") is None


def test_schema_is_found_even_when_another_statement_follows_it():
    """Anchoring on ';</script>' broke whenever Google emitted anything after the
    assignment in the same script block. Bracket balancing does not care."""
    html = _payload([_item(111, "Your name", gform._T_SHORT, required=True)])
    html = html.replace(
        ";</script>", "; var OTHER = [1,2,3]; window.x = 1;</script>",
    )
    schema = gform.parse_form(html)
    assert schema is not None
    assert schema["fields"][0]["entry_id"] == 111


def test_a_bracket_inside_a_question_does_not_truncate_the_schema():
    html = _payload([
        _item(111, "Rate us [1-10] and explain]", gform._T_SHORT, required=True),
        _item(222, "Why this role?", gform._T_PARAGRAPH),
    ])
    schema = gform.parse_form(html)
    assert [f["entry_id"] for f in schema["fields"]] == [111, 222]
    assert "[1-10]" in schema["fields"][0]["label"]


def test_response_url_is_derived_from_the_viewform_url():
    assert gform.response_url(
        "https://docs.google.com/forms/d/e/ABC/viewform?usp=sf_link"
    ) == "https://docs.google.com/forms/d/e/ABC/formResponse"


# ── Refusals ────────────────────────────────────────────────────────────────

def test_file_upload_question_blocks_the_whole_form():
    schema = gform.parse_form(_payload([
        _item(111, "Your name", gform._T_SHORT),
        _item(222, "Upload your resume", gform._T_FILE, required=True),
    ]))
    assert "file upload" in gform.blocking_reason(schema)


def test_required_date_question_blocks_rather_than_being_invented():
    schema = gform.parse_form(_payload([
        _item(111, "Your name", gform._T_SHORT),
        _item(222, "Date of birth", gform._T_DATE, required=True),
    ]))
    assert "will not invent" in gform.blocking_reason(schema)


def test_an_answerable_form_is_not_blocked():
    schema = gform.parse_form(_payload([
        _item(111, "Your name", gform._T_SHORT, required=True),
        _item(222, "Why this role?", gform._T_PARAGRAPH),
    ]))
    assert gform.blocking_reason(schema) is None


def test_sign_in_gated_form_is_sent_to_review(monkeypatch):
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (
        "", "https://accounts.google.com/v3/signin/identifier?x=1"
    ))
    status, why = gform.apply({"title": "X", "company": "Y"}, "letter", "u1", target="https://f/viewform")
    assert status == "needs_review"
    assert "sign-in" in why


def test_missing_target_is_skipped_not_failed():
    status, _ = gform.apply({"title": "X", "company": "Y", "url": ""}, "letter", "u1")
    assert status == "skipped"


# ── Submission ──────────────────────────────────────────────────────────────

def _profile():
    return {
        "name": "Asha Rao", "email": "asha@example.com", "phone": "9876543210",
        "gpa": 8.4, "resume_text": "Built a Django API and a React dashboard.",
    }


def test_a_confirmed_submission_reports_applied(monkeypatch):
    html = _payload([
        _item(111, "Your name", gform._T_SHORT, required=True),
        _item(222, "Phone number", gform._T_SHORT, required=True),
        _item(333, "Can you join immediately?", gform._T_RADIO, ["Yes", "No"], required=True),
    ])
    sent = {}

    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))

    def fake_post(url, fields, timeout=30):
        sent["url"] = url
        sent["fields"] = dict(fields)
        return 200, "<div>Your response has been recorded</div>"

    monkeypatch.setattr(gform, "_post", fake_post)

    rec = {}
    status, why = gform.apply(
        {"title": "Backend Intern", "company": "Acme", "url": "https://f/viewform"},
        "cover letter", "u1", profile=_profile(), record=rec,
        target="https://f/viewform", skills=["Python"],
    )

    assert status == "applied"
    assert "confirmation" in why
    # Facts come from the profile, never from a model.
    assert sent["fields"]["entry.111"] == "Asha Rao"
    assert sent["fields"]["entry.222"] == "9876543210"
    assert sent["fields"]["entry.333"] == "Yes"
    assert sent["fields"]["fbzx"] == "-12345"
    assert rec["answers"]


def test_a_post_without_confirmation_is_ambiguous_not_a_success(monkeypatch):
    html = _payload([_item(111, "Your name", gform._T_SHORT, required=True)])
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))
    monkeypatch.setattr(gform, "_post", lambda url, fields, timeout=30: (200, "<form>again</form>"))

    status, why = gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert status == "needs_review"
    assert "verify manually" in why


def test_a_choice_question_only_ever_receives_one_of_its_own_options(monkeypatch):
    """A value the question does not offer gets the whole response rejected by
    Google, so whatever we send must be an exact option string. "Yes" is not an
    option here — "Yes, from next week" is."""
    html = _payload([
        _item(111, "Are you available immediately?", gform._T_RADIO,
              ["Yes, from next week", "No"], required=True),
        _item(222, "Do you agree to the terms?", gform._T_RADIO, ["I agree", "No"], required=True),
    ])
    sent = {}
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))

    def fake_post(url, fields, timeout=30):
        sent.update(dict(fields))
        return 200, "Your response has been recorded"

    monkeypatch.setattr(gform, "_post", fake_post)

    status, _ = gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert status == "applied"
    assert sent["entry.111"] == "Yes, from next week"
    assert sent["entry.222"] == "I agree"


def test_an_arbitrary_preference_is_never_guessed(monkeypatch):
    """"Preferred campus — Pune / Chennai" has no right answer we hold. The old
    picker took the first option and submitted it as the candidate's stated
    preference. Now it blocks instead."""
    html = _payload([
        _item(111, "Preferred campus", gform._T_DROPDOWN, ["Pune", "Chennai"], required=True),
    ])
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))
    monkeypatch.setattr(gform, "_post", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("must not invent a preference")))

    status, why = gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert status == "needs_review"
    assert "required question" in why


def test_a_rating_scale_is_never_answered_with_the_lowest_value(monkeypatch):
    """A 1-5 scale rendered as options meant the old "first non-placeholder"
    rule submitted 1 — the worst possible self-assessment, unattended."""
    html = _payload([
        _item(111, "Rate your Python skill", gform._T_SCALE, ["1", "2", "3", "4", "5"], required=True),
    ])
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))
    monkeypatch.setattr(gform, "_post", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("must not self-rate on the candidate's behalf")))

    status, _ = gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert status == "needs_review"


def test_the_candidate_name_field_gets_their_name_not_a_paragraph(monkeypatch):
    """A form labelled just "Name" used to miss the profile matcher entirely and
    receive a two-sentence LLM answer — under the candidate's real identity."""
    html = _payload([
        _item(111, "Name", gform._T_SHORT, required=True),
        _item(222, "Father's Name", gform._T_SHORT),
        _item(333, "College Name", gform._T_SHORT),
    ])
    sent = {}
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))

    def fake_post(url, fields, timeout=30):
        sent.update(dict(fields))
        return 200, "Your response has been recorded"

    monkeypatch.setattr(gform, "_post", fake_post)
    # No LLM in tests, so anything not answered from profile stays empty — which
    # is exactly the point: only the candidate's own name field is filled.
    gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert sent["entry.111"] == "Asha Rao"
    assert sent.get("entry.222") != "Asha Rao"   # father's name is not the candidate
    assert sent.get("entry.333") != "Asha Rao"   # nor is the college


def test_an_unanswerable_required_question_is_never_partially_submitted(monkeypatch):
    """A required choice question with no usable option must hold the whole
    application, not send it with that answer missing."""
    html = _payload([
        _item(111, "Pick a slot", gform._T_DROPDOWN, ["-- Select --"], required=True),
    ])
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))
    monkeypatch.setattr(gform, "_post", lambda *a, **k: (_ for _ in ()).throw(
        AssertionError("must not post a partial response")))

    status, why = gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert status == "needs_review"
    assert "required question" in why


def test_a_dead_form_is_skipped_so_the_queue_moves_on(monkeypatch):
    html = _payload([_item(111, "Your name", gform._T_SHORT, required=True)])
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))
    monkeypatch.setattr(gform, "_post", lambda url, fields, timeout=30: (404, ""))

    status, why = gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "letter", "u1", profile=_profile(), target="https://f/viewform",
    )
    assert status == "skipped"
    assert "closed" in why


def test_cover_letter_goes_into_the_cover_letter_box(monkeypatch):
    html = _payload([
        _item(111, "Your name", gform._T_SHORT, required=True),
        _item(222, "Why should we hire you?", gform._T_PARAGRAPH, required=True),
    ])
    sent = {}
    monkeypatch.setattr(gform, "_get", lambda url, timeout=25: (html, url))

    def fake_post(url, fields, timeout=30):
        sent.update(dict(fields))
        return 200, "Your response has been recorded"

    monkeypatch.setattr(gform, "_post", fake_post)

    gform.apply(
        {"title": "X", "company": "Y", "url": "https://f/viewform"},
        "I shipped a Django API that served 40k requests a day.", "u1",
        profile=_profile(), target="https://f/viewform",
    )
    assert sent["entry.222"].startswith("I shipped a Django API")
