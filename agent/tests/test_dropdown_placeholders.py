"""An unanswered dropdown must be recognised as unanswered.

read_fields skips a <select> whose selected option does not look like a
placeholder, because a vendor's own default really is an answer — Keka presets
the phone country code to +91 and the salary currency to INR, and re-asking
those blocked submits.

The cost of a miss is total and silent: the field is never offered to the
answering engine, never filled, and the employer's own validation rejects the
submit with the field still empty. Nothing in our logs says the field existed.

Measured on a live Keka application to Ken Research — Keka being the
highest-yielding vendor in the index. Its placeholder reads "Select an option",
and the pattern required the string to END after "select", so it matched a bare
"Select" and missed this:

    gender             required   "Select an option"  -> skipped, blocked submit
    eligibletowork     required   "Select an option"  -> skipped
    nationality                   "Select an option"  -> skipped
    locationPreference            "Select an option"  -> skipped

Every application to that vendor failed on it.
"""
import questions


def _is_placeholder(text):
    return bool(questions._PLACEHOLDER_LABEL.match(text))


def test_the_exact_text_that_blocked_every_keka_application():
    assert _is_placeholder("Select an option")


def test_the_ways_an_ats_words_an_empty_dropdown():
    for text in ("Select", "Select...", "Select…", "Select one", "Select an option",
                 "Select a value", "Select item", "Please select",
                 "Please select an option", "Choose", "Choose an option",
                 "Pick one", "-- Select --", "--Select--", "Search",
                 "Type to search", "Start typing", "Select your option"):
        assert _is_placeholder(text), text


def test_dashes_alone_are_a_placeholder():
    """Their own case, not decoration around a word. Losing this alternative
    while widening the pattern let a bare "--" through as a real option, and the
    answering engine wrote a sentence about Python into it."""
    for text in ("--", "---", "——", "  --  "):
        assert _is_placeholder(text), text


def test_a_vendor_default_is_an_answer_and_stays_one():
    """The behaviour this guard exists to protect. Keka presets the phone
    country code and the salary currency; treating those as unanswered made us
    re-ask a question we could not improve on, and blocked the submit."""
    for text in ("+91", "INR", "0", "Yes", "No", "India", "Head Office", "Male"):
        assert not _is_placeholder(text), text


def test_a_real_option_that_merely_starts_with_a_placeholder_word():
    """"Select Committee" is a real answer to a real question, and "Choose Life"
    is a real answer to a strange one. Neither is an empty dropdown."""
    for text in ("Select Committee", "Choose Life", "Selected candidates only",
                 "Search Engine Optimisation", "Picking and packing"):
        assert not _is_placeholder(text), text


def test_an_empty_string_is_not_a_placeholder_label():
    """An empty selected option is handled by the caller's own `chosen and ...`
    check, which keeps the field. Matching it here would be harmless but the
    caller's logic is the one that decides, so keep the two from disagreeing."""
    assert not _is_placeholder("")
