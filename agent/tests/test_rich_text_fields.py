"""Rich-text answer boxes are questions too.

Modern ATSs render long-answer questions ("Why this role?", cover letters) as a
contenteditable editor with a toolbar, not a <textarea>. Such a box was
invisible to a `textarea, input, select` query AND invisible to the browser's
own constraint validation — it is not a form control — so an unanswered
REQUIRED rich-text question passed both of our checks and was discovered only
by the employer's own JS rejecting the submit, after the click was spent.

These use a fake element rather than a browser: the contract that matters is
which JS we ask and what we do with each answer.
"""
import questions


class FakeEl:
    """The slice of Playwright's ElementHandle that read_fields actually uses."""

    def __init__(self, tag="DIV", editable=False, attrs=None, text="",
                 value="", visible=True):
        self.tag = tag
        self.editable = editable
        self.attrs = attrs or {}
        self.text = text
        self.value = value
        self.visible = visible

    def evaluate(self, js, *a):
        if "tagName" in js and "isContentEditable" not in js:
            return self.tag
        if "isContentEditable === true" in js and "includes(e.tagName)" in js:
            return self.editable and self.tag not in ("INPUT", "TEXTAREA", "SELECT")
        if "innerText" in js:
            return self.text
        if "selectedIndex" in js:
            return ""
        return ""

    def get_attribute(self, name):
        return self.attrs.get(name)

    def is_visible(self):
        return self.visible

    def input_value(self):
        return self.value

    def query_selector_all(self, _sel):
        return []


class FakePage:
    def __init__(self, els):
        self.els = els

    def query_selector_all(self, selector):
        self.selector = selector
        return self.els


def _read(els):
    page = FakePage(els)
    # _LABEL_JS and the combobox probes are browser-only; stub them out so the
    # test exercises read_fields' own branching rather than Playwright.
    orig_label, orig_combo, orig_ghost, orig_wrap = (
        questions._LABEL_JS, questions._is_combobox,
        questions._select_shell_ghost, questions._wrapper_required,
    )
    questions._LABEL_JS = "LABEL"
    questions._is_combobox = lambda el: False
    questions._select_shell_ghost = lambda el: False
    questions._wrapper_required = lambda el: False
    try:
        return questions.read_fields(page)
    finally:
        (questions._LABEL_JS, questions._is_combobox,
         questions._select_shell_ghost, questions._wrapper_required) = (
            orig_label, orig_combo, orig_ghost, orig_wrap)


def test_the_query_asks_for_contenteditable_at_all():
    page = FakePage([])
    questions.read_fields(page)
    assert "contenteditable" in page.selector


def test_an_empty_rich_text_editor_is_read_as_a_question():
    el = FakeEl(tag="DIV", editable=True, attrs={"aria-required": "true"})
    fields = _read([el])
    assert len(fields) == 1
    assert fields[0]["kind"] == "textarea", "must reuse every textarea rule"
    assert fields[0]["required"] is True


def test_an_already_written_editor_is_left_alone():
    """The caller writes the cover letter before the form is read. Re-typing
    over it would clobber real work."""
    el = FakeEl(tag="DIV", editable=True, text="Dear hiring team, ...")
    assert _read([el]) == []


def test_a_plain_div_is_not_a_question():
    assert _read([FakeEl(tag="DIV", editable=False, text="Some marketing copy")]) == []


def test_a_hidden_editor_is_skipped():
    el = FakeEl(tag="DIV", editable=True, visible=False)
    assert _read([el]) == []


def test_a_native_textarea_is_not_treated_as_rich_text():
    """Some engines report isContentEditable true for a textarea. It already
    has a better path and must keep it."""
    el = FakeEl(tag="TEXTAREA", editable=True)
    assert questions._is_rich_text(el) is False
    fields = _read([el])
    assert len(fields) == 1
    assert fields[0]["kind"] == "textarea"


def test_the_input_only_guards_never_run_on_an_editor():
    """type/name guards are input-shaped. A rich-text editor whose name
    happens to match the skip pattern is still a real question."""
    el = FakeEl(tag="DIV", editable=True, attrs={"name": "cover_letter_body"})
    assert len(_read([el])) == 1


def test_a_file_input_is_still_skipped():
    el = FakeEl(tag="INPUT", attrs={"type": "file"})
    assert _read([el]) == []


def test_live_value_reads_a_contenteditable_by_its_text():
    """Without this the pre-submit gate refuses an application that IS
    complete: a filled editor reads back empty through .value."""
    assert "isContentEditable" in questions._LIVE_VALUE_JS
    assert "innerText" in questions._LIVE_VALUE_JS


def test_is_rich_text_survives_a_dead_element():
    class Boom:
        def evaluate(self, *a):
            raise RuntimeError("detached")

    assert questions._is_rich_text(Boom()) is False
