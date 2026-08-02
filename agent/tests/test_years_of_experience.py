"""A required box the agent had no honest answer for.

"Total Years of Experience *" and "Relevant Years of Experience *" are required
on Keka and Darwinbox forms, and nothing in the profile could answer them.
Measured on a real application to Dash Technologies: the agent filled twelve
questions, reached those two, refused to guess, and stopped at the submit
button. Correct — and it would have done exactly that on every form asking this,
forever.

Zero is the true answer for most students, and it is still a FACT about them
rather than a default we may assume: someone who worked two years before a
masters would have it written wrong under their own name, on an employer's form.
So it is asked once in setup and never inferred.
"""
import channel_ats
import questions


PROFILE = {"years_experience": "0 — no full-time work yet"}


def test_the_forms_that_stopped_a_real_application_are_recognised():
    for label in ("Total Years of Experience *",
                  "Relevant Years of Experience *",
                  "Years of Experience",
                  "Experience (in years)",
                  "Total years of work experience",
                  "Overall Years of Experience"):
        assert questions._YEARS_EXPERIENCE_Q.search(label), label


def test_the_stored_answer_reaches_the_box_as_a_bare_number():
    """Setup offers "0 — no full-time work yet" because a plain digit reads
    like a placeholder to a student who has never worked. The employer's box
    wants the digit."""
    assert questions._years_experience(PROFILE) == "0"
    assert questions._years_experience({"years_experience": "2"}) == "2"
    assert questions._years_experience({"years_experience": "3 years"}) == "3"


def test_an_unanswered_box_is_left_empty_so_the_form_stops_and_asks():
    """The whole safety contract in one assertion: no answer means no guess."""
    assert questions._years_experience({}) == ""
    assert questions._years_experience({"years_experience": ""}) == ""
    assert questions._years_experience({"years_experience": "   "}) == ""


def test_zero_is_never_assumed_for_someone_who_did_not_say_it():
    """The tempting shortcut, and why it is wrong: defaulting to 0 would put a
    false statement about employment history on a real application for anyone
    who worked before studying again."""
    assert questions._years_experience({"grad_year": 2026}) == ""


def test_a_prose_experience_box_is_not_treated_as_this_one():
    """"Describe your experience" wants a paragraph. Answering it with "0"
    would be worse than leaving it for the user."""
    for label in ("Describe your relevant experience",
                  "Tell us about your experience with Python",
                  "Work experience"):
        assert not questions._YEARS_EXPERIENCE_Q.search(label), label


def test_an_unanswered_box_becomes_a_setup_question_not_a_dead_end():
    """Without this the row says "the form will not accept it yet" and nothing
    ever prompts for the answer — so that employer, and every other form asking
    the same thing, stays blocked permanently."""
    said = channel_ats._blocking_facts(["Total Years of Experience *"], {})
    assert said, "an answerable fact was reported as an opaque blocker"
    assert "experience" in " ".join(said).lower()

    keys = channel_ats.blocking_fact_keys(["Total Years of Experience *"], {})
    assert "yearsExperience" in keys


def test_a_fact_already_on_file_is_not_asked_for_again():
    assert channel_ats._blocking_facts(["Total Years of Experience *"], PROFILE) == []
