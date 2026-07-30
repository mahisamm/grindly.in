"""Greenhouse, Ashby and Lever build their dropdowns as react-select.

That means a plain <input role=combobox> with a placeholder of "Select...", no
options in the DOM until it is opened, and no `required` attribute even when the
field is mandatory. The first real application this system ever sent was
rejected because all three of those were misread: the placeholder became the
question, prose was typed into it, and the missing `required` meant nothing
stopped the submit.

The browser half is exercised against the live form by canary_inspect; these pin
the decisions that do not need a browser.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import questions


class FakeEl:
    """Just enough of an ElementHandle to answer the questions read_fields asks."""

    def __init__(self, attrs=None, evaluate_map=None):
        self.attrs = attrs or {}
        self.evaluate_map = evaluate_map or {}

    def get_attribute(self, name):
        return self.attrs.get(name)

    def evaluate(self, script, *args):
        for needle, value in self.evaluate_map.items():
            if needle in script:
                return value
        return False


def _answer(field, profile=None):
    out = questions.answer_fields(
        [field], profile=profile or {}, resume_text="I write Python.",
        skills=["python"], job={"title": "Intern", "company": "X"},
        name="Asha Rao", email="asha@example.com",
    )
    return out[0]


def test_an_input_with_the_combobox_role_is_a_dropdown():
    assert questions._is_combobox(FakeEl({"role": "combobox"})) is True


def test_an_input_that_only_declares_a_list_autocomplete_is_one_too():
    el = FakeEl({}, {"aria-autocomplete": True})
    assert questions._is_combobox(el) is True


def test_a_plain_text_box_is_not_a_dropdown():
    assert questions._is_combobox(FakeEl({"type": "text"}, {"aria-autocomplete": False})) is False


def test_a_combobox_is_answered_from_its_own_options_never_from_prose():
    # The whole failure. A model answered "Select..." with "I don't have
    # information to select from" and the employer's form threw it out.
    rec = _answer({
        "label": "Are you willing to work from the Bangalore office?",
        "kind": "combobox", "required": True, "options": ["Yes", "No"],
    })
    assert rec["answer"] == "Yes"
    assert rec["source"] != "ai"


def test_a_combobox_with_no_honest_answer_is_left_alone():
    # A preference we do not hold is not ours to pick. Unanswered blocks the
    # submit, which is the outcome the candidate can act on.
    rec = _answer({
        "label": "Preferred campus", "kind": "combobox", "required": True,
        "options": ["Pune", "Chennai"],
    })
    assert rec["answer"] == ""
    assert rec["source"] == "unanswerable"


def test_a_stored_fact_answers_a_combobox_in_its_own_words():
    rec = _answer(
        {"label": "Notice period", "kind": "combobox", "required": True,
         "options": ["Immediate", "1 month", "3 months"]},
        profile={"notice_period": "Immediate"},
    )
    assert rec["answer"] == "Immediate"
    assert rec["source"] == "profile"


def test_a_yes_no_question_is_not_answered_yes_by_the_confirm_shortcut():
    # `_CONFIRM` used to answer any question shaped like "can you…" with the
    # literal string "Yes". Typed into a react-select that is not one of its
    # options, and the click throws — so a combobox must go through the option
    # picker like any other dropdown.
    rec = _answer({
        "label": "Can you join us immediately?", "kind": "combobox",
        "required": True, "options": ["Yes, immediately", "No"],
    })
    assert rec["answer"] in ("Yes, immediately", "")
    assert rec["answer"] != "Yes"


def test_the_widgets_own_placeholder_is_never_read_as_an_option():
    # "Select..." in the option list is the widget saying nothing is chosen.
    assert questions._PLACEHOLDER_LABEL.match("Select...")
    assert questions._PLACEHOLDER_LABEL.match("Search")
    assert not questions._PLACEHOLDER_LABEL.match("Yes, immediately")


def test_greenhouses_education_end_year_is_the_graduation_year_we_already_hold():
    # A required number box that stopped a real application dead, while the same
    # year sat in the profile under a different name.
    rec = _answer(
        {"label": "End date year", "kind": "number", "required": True, "options": []},
        profile={"grad_year": 2027},
    )
    assert rec["answer"] == "2027"
    assert rec["source"] == "profile"


def test_a_year_we_do_not_hold_is_still_not_invented():
    rec = _answer({"label": "End date year", "kind": "number", "required": True, "options": []})
    assert rec["answer"] == ""


def test_react_selects_phantom_required_input_is_not_a_question():
    # Every react-select mounts an empty second input beside its combobox, purely
    # so the browser can say "please fill out this field". No name, no label, no
    # options — and required. Treated as a question it is unanswerable by
    # construction, so every dropdown on the page produced a phantom blocker.
    ghost = FakeEl({"class": "remix-css-1a0ro4n-requiredInput"},
                   {"requiredInput": True})
    assert questions._select_shell_ghost(ghost) is True


def test_the_combobox_itself_is_never_treated_as_a_ghost():
    real = FakeEl({"role": "combobox"}, {"requiredInput": False})
    assert questions._select_shell_ghost(real) is False


def test_an_ordinary_text_input_is_not_a_ghost():
    plain = FakeEl({"type": "text", "name": "first_name"}, {"requiredInput": False})
    assert questions._select_shell_ghost(plain) is False


def test_a_named_input_is_never_a_ghost_however_it_is_wrapped():
    # The first version of this test matched on the WRAPPER's class alone, and
    # '-container' turns up on ordinary layout divs. On Keka one dropdown inside
    # a wide wrapper made every real field invisible and the whole apply form
    # read as having no questions at all. A ghost has no name and no id — that
    # is what makes it a ghost.
    keka = FakeEl({"type": "text", "name": "currentSalary.salaryPeriod"},
                  {"requiredInput": False})
    assert questions._select_shell_ghost(keka) is False
