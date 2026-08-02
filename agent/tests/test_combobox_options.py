"""A dropdown's options must be ITS options, and a snapshot is not a catalogue.

Two defects, both measured on a live AlphaGrep Securities application that
filled every other field and stopped at the submit button.

  _combobox_options read every [role="option"] in the DOCUMENT. Greenhouse
  renders an inline phone-country selector, so School, Degree and Location
  (City) all came back offering "Afghanistan+93, Åland Islands+358, ...". None
  of them contains "Anurag University", so all three were declared unanswerable
  while the answers sat in the profile. That would have broken every Greenhouse
  application, not one.

  Then, with the right list in hand, School and Degree still failed: they are
  async autocompletes that query a server as you type, so the options visible
  when the menu first opens are a placeholder list rather than the catalogue.
  Refusing on that snapshot refuses a value the form would have accepted.
"""
import questions


def _field(kind, options):
    return {"kind": kind, "label": "School*", "options": options}


def test_a_native_select_only_accepts_what_it_lists():
    """A <select> enumerates everything it will take, so no match means the
    answer genuinely cannot be expressed in this form's vocabulary. Typing it
    anyway makes select_option() throw and takes the application down."""
    field = _field("select", ["Bachelor's Degree", "Master's Degree"])
    assert questions._fit_option(field, "B.Tech") is None


def test_a_native_select_still_matches_when_it_can():
    field = _field("select", ["Bachelor's Degree", "Master's Degree"])
    assert questions._fit_option(field, "master's degree") == "Master's Degree"


def test_an_autocomplete_passes_the_value_through_to_be_verified_later():
    """The snapshot is not the catalogue. Greenhouse's School box shows a few
    placeholder entries until it is typed into, and "Anurag University" is
    absent from that snapshot and present in the real list.

    Safe because nothing types it blindly: _choose_in_combobox types the value,
    waits for the menu to filter, and picks a matching option — leaving the
    field EMPTY if none appears. The verification still happens, one stage
    later, against the list that actually exists.
    """
    field = _field("combobox", ["Select...", "Popular schools"])
    assert questions._fit_option(field, "Anurag University") == "Anurag University"


def test_an_exact_option_is_still_preferred_over_passing_through():
    field = _field("combobox", ["Anurag University", "Anna University"])
    assert questions._fit_option(field, "anurag university") == "Anurag University"


def test_no_options_at_all_passes_through_for_either_kind():
    for kind in ("select", "combobox"):
        assert questions._fit_option(_field(kind, []), "Hyderabad") == "Hyderabad"


def test_the_three_fields_that_stopped_a_real_greenhouse_application():
    """School, Degree and Location, with the stored answers from the profile
    that was on file when it stopped."""
    for value in ("Anurag University", "B.Tech", "Hyderabad"):
        field = _field("combobox", ["Afghanistan+93", "Åland Islands+358"])
        assert questions._fit_option(field, value) == value, value
