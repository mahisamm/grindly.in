"""Don't spend the click on a form that will refuse it.

Five real applications were clicked through and rejected with "submit click
registered but page shows a validation/error message". Each spent a daily slot
and an idempotency claim on a submit that never had a chance, and none of them
said which field was wrong.

The pre-fill check that existed tested the answers we INTENDED to write. It
comes apart from reality whenever `fill` gives up on a control — a react-select
whose option never matched returns False and moves on quietly, leaving a
required dropdown empty on a form that reads as fully answered.
"""
import questions


class _El:
    """A form control, standing in for a Playwright element handle.

    `live` is what the browser would report the control is holding; `invalid` is
    what its own constraint validation would say when a submit is attempted.
    """

    def __init__(self, live="", invalid=None, label=""):
        self._live = live
        self._invalid = invalid
        self.label = label

    def evaluate(self, js, *args):
        if js is questions._LIVE_VALUE_JS:
            return self._live
        raise AssertionError("unexpected script")


class _Submit:
    """The submit button. Asked, via its own form, what would be refused."""

    def __init__(self, blockers):
        self._blockers = blockers

    def evaluate(self, js, *args):
        assert js is questions._BLOCKERS_JS
        return list(self._blockers)


def _field(label, required=True, live=""):
    return {"el": _El(live=live), "kind": "combobox", "label": label,
            "required": required, "options": []}


# --- what the form is actually holding --------------------------------------

def test_a_chosen_dropdown_reads_as_answered():
    # react-select clears its input and renders the chosen label in the control,
    # so input_value() alone reports every answered dropdown as empty.
    assert questions.live_value(_El(live="India")) == "India"


def test_an_empty_required_field_is_reported_after_filling():
    fields = [_field("Country*", live=""), _field("First Name*", live="Mahendhar")]
    assert questions.unfilled_required(fields) == ["Country*"]


def test_an_empty_optional_field_is_not_a_blocker():
    assert questions.unfilled_required([_field("LinkedIn", required=False)]) == []


def test_a_fully_answered_form_reports_nothing():
    fields = [_field("Country*", live="India"), _field("Phone*", live="8096267553")]
    assert questions.unfilled_required(fields) == []


def test_an_unreadable_element_counts_as_empty_not_as_fine():
    # Fail closed. A control we cannot read is not a control we may assume is
    # filled — that assumption is exactly what sent the rejected applications.
    class _Broken(_El):
        def evaluate(self, js, *args):
            raise RuntimeError("element is not attached to the DOM")

    fields = [{"el": _Broken(), "kind": "text", "label": "Country*", "required": True,
               "options": []}]
    assert questions.unfilled_required(fields) == ["Country*"]


# --- what the browser itself would refuse -----------------------------------

def test_blockers_come_back_with_the_question_attached():
    said = ["Country* — Please select an item in the list"]
    assert questions.form_blockers(None, _Submit(said)) == said


def test_a_ready_form_blocks_nothing():
    assert questions.form_blockers(None, _Submit([])) == []


def test_a_page_that_cannot_be_read_does_not_crash_the_send():
    class _Dead:
        def evaluate(self, js, *args):
            raise RuntimeError("Execution context was destroyed")

    assert questions.form_blockers(None, _Dead()) == []


def test_with_no_submit_button_the_whole_document_is_asked():
    class _Page:
        def evaluate(self, js, arg):
            assert js is questions._BLOCKERS_JS
            assert arg is None
            return ["Resume* — Please select a file"]

    assert questions.form_blockers(_Page()) == ["Resume* — Please select a file"]
