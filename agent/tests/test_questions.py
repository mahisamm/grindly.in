"""Screening answers go out under the candidate's name. The rules that matter are
about what must NOT happen: no invented credentials, no identical filler, nothing
submitted that the user can't read back afterwards."""
import json
from unittest.mock import patch

import questions


PROFILE = {"phone": "9876543210", "gpa": 8.4}
RESUME = "Built Grindly, a job-application agent, with Python, React and Postgres."
SKILLS = ["python", "react", "postgresql"]
JOB = {"title": "Backend Intern", "company": "Acme"}


def _field(label, kind="textarea", required=True, options=None):
    """A form field as read_fields() would hand it over, minus the live element."""
    return {"el": None, "kind": kind, "label": label,
            "required": required, "options": options or []}


def _answer(fields, **kw):
    opts = dict(profile=PROFILE, resume_text=RESUME, skills=SKILLS, job=JOB,
                name="Mahendhar", email="m@example.com")
    opts.update(kw)
    return questions.answer_fields(fields, **opts)


# --- "duration" is a text answer, not a yes/no confirm ----------------------
# "duration" used to be in the confirm set, so a free-text field asking how long
# the candidate can commit got a literal "Yes" typed in — nonsense to a recruiter,
# or rejected by a numeric input. It must fall through to the LLM instead.

def test_duration_text_question_is_not_answered_yes():
    f = _field("Internship duration you can commit to?", kind="text")
    assert questions._deterministic(f, PROFILE, "Mahendhar", "m@example.com") is None


def test_genuine_availability_confirm_still_answers_yes():
    # The fix must not break real yes/no availability questions on text fields.
    f = _field("Are you available to join immediately?", kind="text", required=True)
    assert questions._deterministic(f, PROFILE, "Mahendhar", "m@example.com") == "Yes"


# --- facts come from the profile, never from a model ------------------------
# A model asked for a CGPA will happily produce a plausible one. That is a
# fabricated credential on a real application.

def test_cgpa_comes_from_the_profile_not_a_model():
    """It used to be hardcoded to "8.5" while the user's real GPA sat unread."""
    with patch.object(questions.llm_mod, "chat_json_ensemble") as llm:
        out = _answer([_field("What is your CGPA?", kind="number")])
    llm.assert_not_called()
    assert out[0]["answer"] == "8.4"
    assert out[0]["source"] == "profile"


def test_phone_comes_from_the_profile():
    out = _answer([_field("Your mobile number", kind="tel")])
    assert out[0]["answer"] == "9876543210"
    assert out[0]["source"] == "profile"


def test_name_and_email_come_from_the_account():
    out = _answer([
        _field("Your name", kind="text"),
        _field("Email address", kind="text"),
    ])
    assert [a["answer"] for a in out] == ["Mahendhar", "m@example.com"]
    assert all(a["source"] == "profile" for a in out)


def test_a_missing_profile_fact_is_left_blank_rather_than_guessed():
    """No GPA on file means we say nothing. It does not mean we make one up."""
    out = _answer([_field("CGPA", kind="number")], profile={})
    assert out[0]["answer"] in ("", None) or out[0]["source"] != "profile"


# --- free text is grounded in the resume ------------------------------------

def test_each_question_gets_its_own_answer():
    """Every textarea used to receive the SAME canned sentence, whatever it asked."""
    fake = {"0": "I built Grindly in Python.", "1": "I can commit 30 hours a week."}
    with patch.object(questions.llm_mod, "chat_json_ensemble", return_value=fake):
        out = _answer([
            _field("Why should we hire you?"),
            _field("How many hours a week can you commit?"),
        ])
    assert out[0]["answer"] != out[1]["answer"]
    assert "Grindly" in out[0]["answer"]


def test_the_llm_is_given_the_resume_to_ground_its_answer():
    with patch.object(questions.llm_mod, "chat_json_ensemble", return_value={}) as llm:
        _answer([_field("Describe a project you have built.")])
    prompt = llm.call_args[0][0]
    assert "Grindly" in prompt          # the resume is in the prompt
    assert "Backend Intern" in prompt   # ...and so is the role


def test_a_long_model_answer_is_truncated():
    with patch.object(questions.llm_mod, "chat_json_ensemble",
                      return_value={"0": "x" * 5000}):
        out = _answer([_field("Why you?")])
    assert len(out[0]["answer"]) <= questions.MAX_ANSWER_CHARS


def test_a_required_box_is_never_left_empty_when_the_llm_fails():
    """An empty required field blocks the submit outright, so it needs something —
    but it must be something the skill list actually supports."""
    with patch.object(questions.llm_mod, "chat_json_ensemble", return_value=None):
        out = _answer([_field("Why should we hire you?", required=True)])
    assert out[0]["answer"]
    assert out[0]["source"] == "fallback"
    assert "python" in out[0]["answer"].lower()   # drawn from real skills


# --- logistics questions ----------------------------------------------------

def test_availability_is_answered_yes_without_burning_an_llm_call():
    with patch.object(questions.llm_mod, "chat_json_ensemble") as llm:
        out = _answer([_field("Are you available for 6 months?", kind="text")])
    llm.assert_not_called()
    assert out[0]["answer"] == "Yes"


def test_a_dropdown_prefers_an_affirmative_option_over_the_placeholder():
    out = _answer([_field("Available to start?", kind="select",
                          options=["-- Select --", "Yes, immediately", "No"])])
    assert out[0]["answer"] == "Yes, immediately"


# --- the record the user reads back -----------------------------------------

def test_the_record_captures_the_question_the_answer_and_its_source():
    with patch.object(questions.llm_mod, "chat_json_ensemble",
                      return_value={"1": "I built Grindly."}):
        out = _answer([
            _field("CGPA", kind="number"),
            _field("Why should we hire you?"),
        ])
    rec = json.loads(questions.to_record(out))
    assert rec == [
        {"q": "CGPA", "a": "8.4", "source": "profile"},
        {"q": "Why should we hire you?", "a": "I built Grindly.", "source": "ai"},
    ]


def test_the_record_holds_no_element_handles():
    """to_record() output goes straight into a DB column — a Playwright handle in
    there would raise on serialization."""
    out = _answer([_field("CGPA", kind="number")])
    assert "_i" not in json.loads(questions.to_record(out))[0]
    assert "el" not in json.loads(questions.to_record(out))[0]


def test_unanswered_fields_stay_out_of_the_record():
    with patch.object(questions.llm_mod, "chat_json_ensemble", return_value={}):
        out = _answer([_field("Optional extra?", required=False)])
    assert json.loads(questions.to_record(out)) == []
