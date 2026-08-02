"""Form labels that stopped a real application while the answer was on file.

The worst class of miss in this system. The user answered the question in setup,
the value is sitting in their profile, and the agent still stops at the submit
button — because the employer words the box differently from the way we do. From
the outside it is indistinguishable from a fact the user never gave, and the
dashboard asks them for something they already provided.

Both of these were measured on a live AlphaGrep Securities application that
filled every other field and stopped on: "Location (City)*; School*".
"""
import questions


PROFILE = {
    "college": "MIET Meerut",
    "degree": "B.Tech",
    "current_location": "Hyderabad",
    "class12_percent": 88,
}


def _answer(label, profile=None):
    hits = [(k, v) for ok, k, v in
            questions._setup_candidates(label, profile or PROFILE) if ok]
    return hits[0] if hits else None


def test_school_is_what_greenhouse_calls_the_college_box():
    for label in ("School*", "School", "Name of School", "School attended"):
        assert _answer(label) == ("college", "MIET Meerut"), label


def test_the_college_words_we_already_handled_still_work():
    for label in ("College name", "University", "Institute", "Institution name"):
        assert _answer(label) == ("college", "MIET Meerut"), label


def test_a_school_PERCENTAGE_box_is_not_answered_with_a_college_name():
    """"School" also appears in questions about class 10 and 12 marks. Writing
    "MIET Meerut" into a percentage box would be worse than leaving it: it is a
    nonsense answer stated under the candidate's name."""
    for label in ("High School Percentage", "Schooling marks",
                  "School Board", "High School Grade"):
        got = _answer(label)
        assert got is None or got[0] != "college", f"{label} -> {got}"


def test_location_city_is_where_the_candidate_lives():
    for label in ("Location (City)*", "Location (City)", "City", "City*"):
        assert _answer(label) == ("current_location", "Hyderabad"), label


def test_a_location_question_about_the_JOB_is_not_answered_with_their_address():
    """"Preferred Location" and "Job Location" ask where they want to WORK,
    which is a different question with a different answer — and each has its own
    pattern ahead of this one."""
    for label in ("Preferred Location", "Job Location", "Preferred work location"):
        got = _answer(label)
        assert got is None or got[0] != "current_location", f"{label} -> {got}"


def test_the_other_facts_a_live_run_stopped_on_are_still_matched():
    """Regression net for the whole set measured across two real runs."""
    profile = {**PROFILE, "gender": "Male",
               "years_experience": "0 — no full-time work yet",
               "current_salary": "Not earning — I am a student"}
    assert _answer("Gender *", profile) == ("gender", "Male")
    assert _answer("Total Years of Experience *", profile) == ("years_experience", "0")
    assert _answer("Degree*", profile) == ("degree", "B.Tech")
    assert _answer("Current Salary", profile)[0] == "current_salary"
