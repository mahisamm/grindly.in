"""What the first real submission taught us about reading a form.

Two Greenhouse applications were filled, submitted, and rejected with a
validation error. The stored answers showed why:

    'Country*'       [text]   <- 'India'                              (ai)
    ''               [text*]  <- 'I have experience as an AI Intern…'  (ai)
    'Search'         [search] <- 'I can use search functionality…'     (ai)
    'End date year*' [number] <- "I don't have a specific end date…"   (ai)
    'Select...'      [text*]  <- "I don't have information to select"  (ai)

Greenhouse builds its dropdowns as React comboboxes — a plain <input> whose only
text is a placeholder — so the label scraper returned "Select..." and "Search"
and the model dutifully answered them. None of this is visible to a dry run that
stops at the submit button, which is exactly why it survived a 100/100 score.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import questions


def _field(label, kind="text", required=True, options=None):
    return {"label": label, "kind": kind, "required": required, "options": options or []}


def _answer(field, profile=None):
    out = questions.answer_fields(
        [field], profile=profile or {}, resume_text="I write Python.",
        skills=["python"], job={"title": "Intern", "company": "X"},
        name="Asha Rao", email="asha@example.com",
    )
    return out[0]


def test_a_combobox_placeholder_is_not_a_question():
    # "Select..." is what the widget says when nothing is chosen. Answering it
    # types prose into a required dropdown and the form rejects the submission.
    for placeholder in ("Select...", "Select…", "Search", "Choose", "--"):
        rec = _answer(_field(placeholder))
        assert rec["source"] == "unanswerable", f"{placeholder!r} was answered {rec['answer']!r}"
        assert rec["answer"] == ""


def test_a_field_with_no_readable_label_is_left_for_the_candidate():
    rec = _answer(_field(""))
    assert rec["source"] == "unanswerable"
    assert rec["answer"] == ""


def test_prose_never_goes_into_an_input_that_only_takes_a_number():
    # "End date year*" got "I don't have a specific end date to provide as my
    # current ex…" typed into a number box. Client-side validation killed the
    # application before a human read a word of it.
    rec = _answer(_field("End date year", kind="number"))
    assert rec["answer"] == ""
    assert rec["source"] == "unanswerable"


def test_a_date_box_is_the_same_rule():
    assert _answer(_field("Available from", kind="date"))["answer"] == ""


def test_a_real_question_still_reaches_the_model():
    # The guard must not swallow the boxes the model exists for. With no LLM
    # provider configured the answer lands on the honest-sentence fallback
    # instead — either way it is ANSWERED, which is the property under test.
    rec = _answer(_field("Why do you want to work here?", kind="textarea"))
    assert rec["source"] in ("ai", "fallback")
    assert rec["answer"]


def test_a_stored_fact_still_answers_a_typed_input():
    # The block is on the MODEL, not on the field. A number we actually hold is
    # still typed in — otherwise this fix would stall every phone and CGPA box.
    rec = _answer(_field("Phone", kind="tel"), profile={"phone": "9000000000"})
    assert rec["answer"] == "9000000000"
    assert rec["source"] == "profile"


def test_country_comes_from_the_profile_not_a_model():
    rec = _answer(_field("Country"), profile={"country": "India"})
    assert rec["answer"] == "India"
    assert rec["source"] == "profile"


def test_country_we_do_not_hold_is_left_blank_rather_than_guessed():
    # It answered "India" on a real form from the résumé alone. Plausible,
    # unverified, and stated under the candidate's name.
    rec = _answer(_field("Country"))
    assert rec["answer"] == ""
    assert questions.missing_fact_for("Country", {}) == "country"


def test_country_of_citizenship_is_still_the_nationality_question():
    rec = _answer(_field("Country of citizenship"), profile={"nationality": "Indian"})
    assert rec["answer"] == "Indian"
