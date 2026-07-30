"""What was stopping every Keka application.

A dry run of four Keka forms stopped on `unanswered_required` every time, and one
blocker was common to all four: a REQUIRED field whose label read

    "First Name * Middle Name Last Name * Mobile Phone * Email * "

— the whole section, not a question. It matched the phone pattern, so a dropdown
was handed a phone number; refused, it blocked the submit on all four forms.

The other two were units and vocabulary: a numeric "in days" box against a stored
phrase, and "Preferred Location" against a stored list of locations.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import questions


def _ask(label, kind="text", profile=None, options=None):
    field = {"label": label, "kind": kind, "required": True, "options": options or []}
    return questions.answer_fields(
        [field], profile=profile or {}, resume_text="I write Python.",
        skills=["python"], job={"title": "Intern", "company": "X"},
        name="Asha Rao", email="asha@example.com",
    )[0]


def test_a_label_carrying_several_questions_is_not_a_question():
    # Two asterisks is the tell: a form marks one required field with one star.
    assert questions.unreadable_label(
        "First Name * Middle Name Last Name * Mobile Phone * Email * "
    )


def test_one_long_genuine_question_is_still_a_question():
    # The guard must not swallow the wordy screening questions that are real.
    assert not questions.unreadable_label(
        "This internship will be for 3 Months - Are you available 4 days a week?*"
    )


def test_a_section_blob_is_never_answered():
    rec = _ask("First Name * Middle Name Last Name * Mobile Phone * Email * ",
               kind="select", profile={"phone": "9000000000"},
               options=["+91", "+1"])
    assert rec["answer"] == ""
    assert rec["source"] == "unanswerable"


def test_join_in_days_converts_the_answer_we_hold():
    # "Available To Join (in days)" is a required NUMBER box and the stored answer
    # is a phrase. Converting the candidate's own answer into the unit the form
    # demands invents nothing; blocking the application over a unit is just a
    # worse way to be right.
    assert _ask("Available To Join (in days)", "number",
                {"availability": "Immediately"})["answer"] == "0"
    assert _ask("Available To Join (in days)", "number",
                {"availability": "Within 2 weeks"})["answer"] == "14"
    assert _ask("Available To Join (in days)", "number",
                {"notice_period": "1 month"})["answer"] == "30"


def test_an_explicit_day_count_is_used_as_written():
    assert questions._join_in_days({"notice_period": "15 days"}) == "15"


def test_an_answer_with_no_honest_day_count_is_refused():
    # "After my current semester" has no number that would not be a guess.
    assert questions._join_in_days({"availability": "After my current semester"}) is None
    assert _ask("Available To Join (in days)", "number",
                {"availability": "After my current semester"})["answer"] == ""


def test_preferred_location_comes_from_the_locations_they_chose():
    rec = _ask("Preferred Location", "text",
               {"preferred_locations": '["Hyderabad", "Remote"]'})
    assert rec["answer"] == "Hyderabad"
    assert rec["source"] == "profile"


def test_preferred_location_is_not_where_they_currently_live():
    # Two different questions, asked separately on Indian portals.
    rec = _ask("Preferred Location", "text",
               {"current_location": "Chennai", "preferred_locations": '["Pune"]'})
    assert rec["answer"] == "Pune"


def test_no_locations_chosen_means_no_answer_invented():
    assert _ask("Preferred Location", "text", {"preferred_locations": "[]"})["answer"] == ""
