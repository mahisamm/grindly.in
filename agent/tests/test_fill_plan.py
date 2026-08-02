"""The browser is the hands; this is the brain.

Every wall in front of unattended applying — Keka's typed captcha, Greenhouse's
emailed code, Internshala's session — asks the same question: is a human here?
From a datacenter the honest answer is no, so the student's own browser has to
do the clicking.

But the extension's own decision logic is four regexes (phone, email, CGPA,
name). It cannot read a `<select>` at all, and it knows nothing about gender,
school, degree, years of experience, notice period or expected stipend — most of
which `questions.py` learned the hard way, against real forms that stopped
mid-application. Reimplementing that in JavaScript would mean rediscovering
every one of those bugs a second time.

So the extension sends a snapshot and this answers it with the SAME engine the
server-side sender uses. These tests pin that the two paths cannot drift: the
facts the browser could never answer alone, the refusals that must survive, and
the ordering rules that decide which box gets the cover letter.
"""
import fill_plan


CANDIDATE = {
    "gender": "Male",
    "years_experience": "0 — no full-time work yet",
    "college": "Anurag University",
    "degree": "B.Tech",
    "current_location": "Hyderabad",
    "grad_year": 2027,
    "grad_month": 5,
    "phone": "9876543210",
    "current_salary": "Not earning — I am a student",
}


def _plan(fields, **kw):
    kw.setdefault("profile", CANDIDATE)
    kw.setdefault("name", "Mahendhar Sammeta")
    kw.setdefault("email", "m@example.com")
    return fill_plan.plan(fields, **kw)


def _by_label(result, needle):
    for f in result["fills"]:
        if needle.lower() in f["label"].lower():
            return f
    return None


# ── the facts the extension could never answer on its own ─────────────────

def test_a_dropdown_is_answered_at_all():
    """The extension's field reader queries only textarea/input/contenteditable,
    so every <select> on every form is invisible to it. Gender is a required
    select on Keka — the largest source of Indian internships — and it is the
    single field that blocked those applications."""
    out = _plan([{"index": 0, "label": "Gender *", "kind": "select", "required": True,
                  "options": ["Select an option", "Male", "Female", "Non-binary"]}])
    assert _by_label(out, "gender")["value"] == "Male"


def test_the_facts_a_live_run_measured_forms_stopping_on():
    """Each of these stopped a real application today with the answer already in
    the profile. None of them is in the extension's four regexes."""
    out = _plan([
        {"index": 0, "label": "Total Years of Experience *", "kind": "text", "required": True},
        {"index": 1, "label": "School*", "kind": "combobox", "required": True,
         "options": ["Other", "Anna University"]},
        {"index": 2, "label": "Location (City)*", "kind": "text", "required": True},
        {"index": 3, "label": "End date year*", "kind": "number", "required": True},
        {"index": 4, "label": "End date month*", "kind": "text", "required": True},
        {"index": 5, "label": "Current Salary *", "kind": "text", "required": True},
    ])
    assert _by_label(out, "years of experience")["value"] == "0"
    assert _by_label(out, "school")["value"] == "Anurag University"
    assert _by_label(out, "location")["value"] == "Hyderabad"
    assert _by_label(out, "end date year")["value"] == "2027"
    assert _by_label(out, "end date month")["value"] == "May"
    # The friendly setup wording must not reach a numeric salary box.
    assert _by_label(out, "current salary")["value"] == "0"


def test_the_candidates_own_name_and_contact_still_come_through():
    out = _plan([
        {"index": 0, "label": "First Name *", "kind": "text", "required": True},
        {"index": 1, "label": "Email *", "kind": "email", "required": True},
        {"index": 2, "label": "Mobile Phone *", "kind": "tel", "required": True},
    ])
    assert _by_label(out, "first name")["value"] == "Mahendhar"
    assert _by_label(out, "email")["value"] == "m@example.com"
    assert _by_label(out, "mobile")["value"] == "9876543210"


# ── the refusals have to survive the trip ─────────────────────────────────

def test_a_fact_nobody_gave_us_is_refused_not_invented():
    """The whole contract in one assertion. An empty profile means the box stays
    empty and is reported, rather than filled with something plausible."""
    out = _plan([{"index": 0, "label": "What is your CGPA?", "kind": "text",
                  "required": True}], profile={})
    assert out["fills"] == []
    assert [u["label"] for u in out["unanswered"]] == ["What is your CGPA?"]


def test_only_REQUIRED_gaps_are_reported_as_blocking():
    """An optional box we cannot answer is not a reason to stop; a required one
    is. The extension shows the second to the user."""
    out = _plan([
        {"index": 0, "label": "What is your CGPA?", "kind": "text", "required": False},
        {"index": 1, "label": "Class 12 percentage", "kind": "text", "required": True},
    ], profile={})
    assert out["unanswered"] == [] or all(u["required"] for u in out["unanswered"])


def test_every_answer_says_where_it_came_from():
    """"profile" is a fact the user gave; "ai" is a model phrasing their resume.
    The user is shown which, and a silent guess is the outcome this whole system
    exists to prevent."""
    out = _plan([{"index": 0, "label": "Gender *", "kind": "select", "required": True,
                  "options": ["Male", "Female"]}])
    assert out["fills"][0]["source"] == "profile"


# ── the page's own state is respected ─────────────────────────────────────

def test_a_box_the_page_already_filled_is_left_alone():
    """Typing over a prefilled value is exactly how a live Keka form received
    'SammetaMahendhar' and an email with two @ signs."""
    out = _plan([{"index": 0, "label": "First Name *", "kind": "text",
                  "required": True, "value": "Mahendhar"}])
    assert out["fills"] == []
    assert out["considered"] == 0


def test_a_dropdown_showing_a_placeholder_is_still_answered():
    """Unlike a text box, a <select> reading "Select an option" is NOT answered —
    that is the placeholder, and treating it as a value is what hid Gender on
    every Keka form."""
    out = _plan([{"index": 0, "label": "Gender *", "kind": "select", "required": True,
                  "value": "Select an option",
                  "options": ["Select an option", "Male", "Female"]}])
    assert _by_label(out, "gender")["value"] == "Male"


def test_the_browsers_own_indexes_come_back_untouched():
    """The extension addresses fields by ITS index. Handing back a different one
    types the right answer into the wrong box."""
    out = _plan([
        {"index": 11, "label": "First Name *", "kind": "text", "required": True},
        {"index": 4, "label": "Gender *", "kind": "select", "required": True,
         "options": ["Male", "Female"]},
    ])
    assert {f["index"] for f in out["fills"]} == {11, 4}
    assert _by_label(out, "first name")["index"] == 11
    assert _by_label(out, "gender")["index"] == 4


# ── the cover letter goes in the right box, and only there ────────────────

def test_the_letter_takes_the_box_that_asked_for_prose():
    out = _plan([{"index": 0, "label": "Why do you want this role?",
                  "kind": "textarea", "required": True}],
                cover_letter="Dear Mactores team, ...")
    assert out["fills"][0]["value"] == "Dear Mactores team, ..."
    assert out["fills"][0]["source"] == "cover"


def test_the_letter_beats_the_engines_generic_fallback():
    """The fallback exists so a free-text question is not left empty. A letter
    written for THIS employer beats it, and channel_ats already prefers the
    letter — the two paths would otherwise answer the same box differently."""
    out = _plan([{"index": 0, "label": "Why should we hire you?",
                  "kind": "textarea", "required": True}],
                cover_letter="Because I have shipped...")
    assert out["fills"][0]["source"] == "cover"


def test_the_letter_never_lands_in_an_unrelated_question():
    out = _plan([{"index": 0, "label": "Describe a project you are proud of",
                  "kind": "textarea", "required": True}],
                cover_letter="Dear team, ...")
    got = out["fills"][0]
    assert got["source"] != "cover"
    assert "Dear team" not in got["value"]


def test_the_letter_never_lands_in_a_one_line_box():
    out = _plan([{"index": 0, "label": "Why this company?", "kind": "text",
                  "required": True}], cover_letter="Dear team, ...")
    assert not any(f["source"] == "cover" for f in out["fills"])


# ── it must never be the thing that breaks a browser mid-application ──────

def test_a_field_with_no_label_is_skipped_rather_than_guessed():
    out = _plan([{"index": 0, "label": "", "kind": "text", "required": True}])
    assert out["fills"] == []


def test_a_widget_we_cannot_name_does_not_derail_the_rest():
    out = _plan([
        {"index": 0, "label": "Some slider thing", "kind": "range", "required": False},
        {"index": 1, "label": "First Name *", "kind": "text", "required": True},
    ])
    assert _by_label(out, "first name")["value"] == "Mahendhar"


def test_an_empty_form_is_an_answer_not_an_error():
    assert fill_plan.plan([], profile={})["fills"] == []
    assert fill_plan.plan(None, profile={})["fills"] == []


def test_junk_from_the_browser_never_raises():
    """A browser waiting on a fill plan must get an answer. A crash here leaves
    a real application half-typed in somebody's tab."""
    for junk in ([{"index": "x"}], [{}], [None], [{"label": None, "options": "nope"}]):
        out = fill_plan.plan(junk, profile=CANDIDATE, name="M", email="m@x.com")
        assert isinstance(out.get("fills"), list)
