"""A blocker the user could clear must be ASKED for, not just reported.

Measured on a live Keka form: after the field-corruption fix, the only
remaining stopper was "Gender * — Please select an item in the list." Gender is
a fact setup already knows how to collect, and the profile's was blank — but
this refusal came from the browser's own validation, which never populated
`blocking_facts`. So the row said "the form will not accept it yet" and nothing
ever prompted for the answer. One blank field blocked that employer's form, and
every other form asking the same thing, permanently.
"""
import channel_ats


PROFILE = {"gender": "", "date_of_birth": "", "phone": "9876543210"}


def test_a_browser_validation_blocker_is_mapped_to_a_setup_question():
    labels = ["Gender * — Please select an item in the list."]
    keys = channel_ats.blocking_fact_keys(
        [b.split(" — ")[0].strip() for b in labels], PROFILE)
    assert "gender" in keys


def test_the_user_facing_reason_names_the_fact_not_the_widget():
    said = channel_ats._blocking_facts(["Gender *"], PROFILE)
    assert said, "a fact the user can give was reported as an opaque blocker"
    assert "gender" in " ".join(said).lower()


def test_a_blocker_nobody_can_fix_is_still_reported_plainly():
    """Not every blocker is a setup gap. A vendor's own broken resume parser
    ("Unable to process this file") is not something the user can answer, and
    must not be dressed up as one."""
    labels = ["Unable to process this file. Please add the details below manually"]
    assert channel_ats._blocking_facts(labels, PROFILE) == []


def test_a_fact_already_on_file_is_not_asked_for_again():
    filled = {**PROFILE, "gender": "Male"}
    assert channel_ats._blocking_facts(["Gender *"], filled) == []


def test_the_label_is_split_off_the_validation_message():
    """The browser gives 'Label — message'; only the label identifies a fact."""
    raw = "Date of Birth * — Please fill out this field."
    assert raw.split(" — ")[0].strip() == "Date of Birth *"
    keys = channel_ats.blocking_fact_keys([raw.split(" — ")[0].strip()], PROFILE)
    assert "dateOfBirth" in keys
