"""Type into an EMPTY field, or corrupt the application.

Several ATSs parse the uploaded resume and prefill name, email and phone —
asynchronously, so the value lands AFTER read_fields decided the box was empty.
Playwright's type() then inserts at the cursor instead of replacing. A live Keka
form was filled and read back:

    First Name  'SammetaMahendhar'
    Phone       '8096267553809'
    Email       'mahendharsammeta2mahendharsammeta21@gmail.com1@gmail.com'

The employer's own validation caught the email. That is what every "submit
click registered but page shows a validation error" failure on an employer
form actually was — not a captcha, a mangled identity.
"""
import channel_ats
import questions


class FakeEl:
    def __init__(self, existing=""):
        self.value = existing
        self.presses: list[str] = []
        self.typed: list[str] = []

    def press(self, key):
        self.presses.append(key)
        if key == "Control+a":
            self._selected = True
        elif key == "Backspace" and getattr(self, "_selected", False):
            self.value = ""

    def type(self, text, delay=None):  # noqa: A003
        self.typed.append(text)
        self.value += text

    def click(self):
        pass

    def fill(self, text):
        self.value = text


class FakePage:
    pass


def test_a_prefilled_field_is_cleared_before_typing():
    """The measured bug: Keka prefilled 'Sammeta', we typed 'Mahendhar', and
    the employer received 'SammetaMahendhar'."""
    el = FakeEl(existing="Sammeta")
    channel_ats._human_type(FakePage(), el, "Mahendhar")
    assert el.value == "Mahendhar"


def test_an_email_never_ends_up_with_two_at_symbols():
    el = FakeEl(existing="mahendharsammeta21@gmail.com")
    channel_ats._human_type(FakePage(), el, "priya@example.com")
    assert el.value.count("@") == 1
    assert el.value == "priya@example.com"


def test_an_empty_field_is_unaffected():
    el = FakeEl()
    channel_ats._human_type(FakePage(), el, "hello")
    assert el.value == "hello"


def test_the_clear_is_a_keyboard_clear_not_a_programmatic_write():
    """fill('') dispatches one input event that some React forms treat as a
    programmatic write and revert; a keyboard clear is indistinguishable from
    a person."""
    el = FakeEl(existing="old")
    channel_ats._human_type(FakePage(), el, "new")
    assert el.presses[:2] == ["Control+a", "Backspace"]


def test_a_field_that_refuses_keys_still_gets_cleared():
    class Stubborn(FakeEl):
        def press(self, key):
            raise RuntimeError("no keyboard here")

    el = Stubborn(existing="old")
    channel_ats._human_type(FakePage(), el, "new")
    assert el.value == "new"


# --- and prose never reaches a numeric box ----------------------------------

def test_a_years_of_experience_box_is_a_number_not_a_story():
    """A model answered "Experience (in years)" with "I have around 2-3 years
    of experience, as indicated by my..." and the field mangled it to
    '0232021'."""
    for label in ("Experience (in years)", "Total experience in years",
                  "Notice period in months", "Years of experience"):
        assert questions._WANTS_A_DATUM.search(label), label


def test_a_genuine_open_question_is_still_open():
    for label in ("Why do you want this role?",
                  "Tell us about a project you are proud of"):
        assert not questions._WANTS_A_DATUM.search(label), label
