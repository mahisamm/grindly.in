"""A friendly setup label must never reach an employer's numeric box.

Setup deliberately words some options for the person answering them: "Not
earning — I am a student" instead of 0, "0 — no full-time work yet" instead of
0. A bare zero reads like a placeholder to somebody who has never been paid and
never held a job, so the phrasing is right — for setup.

It is wrong for the employer. Measured on a live Keka application to Ken
Research, the sentence itself was typed into `Current Salary *`:

    {"q": "Current Salary *", "a": "Not earning — I am a student"}

which is a numeric box on the employer's form, filled under the candidate's own
name. The same defect was fixed for years-of-experience one commit earlier and
missed here, which is why this file now covers the whole class rather than one
field.
"""
import questions


def test_not_earning_reaches_a_salary_box_as_zero():
    assert questions._current_salary(
        {"current_salary": "Not earning — I am a student"}) == "0"


def test_the_other_ways_a_person_says_they_earn_nothing():
    for said in ("Not earning", "no salary", "No current income",
                 "unemployed", "I am a student"):
        assert questions._current_salary({"current_salary": said}) == "0", said


def test_a_real_figure_survives_as_a_number():
    assert questions._current_salary({"current_salary": "25000"}) == "25000"
    assert questions._current_salary({"current_salary": "3,00,000"}) == "300000"


def test_an_unanswered_salary_is_left_empty_so_the_form_asks():
    assert questions._current_salary({}) == ""
    assert questions._current_salary({"current_salary": "  "}) == ""


def test_years_of_experience_gets_the_same_treatment():
    """The sibling field, fixed one commit earlier — kept here so the pair
    cannot drift apart again."""
    assert questions._years_experience(
        {"years_experience": "0 — no full-time work yet"}) == "0"
    assert questions._years_experience({"years_experience": "2"}) == "2"


def test_no_setup_prose_survives_into_either_answer():
    """The property that actually matters: whatever setup words for a human,
    what reaches the form is digits."""
    for profile, fn in (
        ({"current_salary": "Not earning — I am a student"}, questions._current_salary),
        ({"years_experience": "0 — no full-time work yet"}, questions._years_experience),
    ):
        answer = fn(profile)
        assert answer.isdigit(), f"{profile} -> {answer!r}"
