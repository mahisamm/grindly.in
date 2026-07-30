"""A submit that was clicked and rejected must leave a trace.

Two real Greenhouse applications were filled, submitted, and thrown out by the
employer's form. Afterwards they existed only as a sentence in an application
row's `reason` column — because `failed` releases the idempotency claim, and the
claim row IS the receipt, so releasing DELETES it.

The claim still goes: the form rejected us, nothing reached the employer, and a
retry after a fix has to stay possible. What must not vanish is the fact that a
submit button was pressed on that posting at that moment.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import apply_score


def test_a_login_only_form_is_not_counted_against_the_agent():
    # The employer restricted their Google Form to signed-in accounts. Nobody
    # applying anonymously can complete it, so grading us on it measures
    # somebody else's access policy.
    assert "sign_in_required" in apply_score._NOT_THE_AGENTS_FAULT


def test_a_login_only_form_is_excluded_from_fillability():
    report = {"listings": [
        {"tier": "A", "target": "https://x", "host_class": "employer",
         "dry_run": {"outcome": "submit_ready", "answers_total": 3}},
        {"tier": "A", "target": "https://y", "host_class": "employer",
         "dry_run": {"outcome": "sign_in_required", "answers_total": 0}},
    ]}
    score, detail = apply_score._fillability(report)
    # One graded run, one ready: a clean 1.0 rather than 0.5 against a door
    # nobody holds a key to.
    assert detail["graded"] == 1
    assert detail["submit_ready"] == 1
    assert detail["excluded_not_the_agents_call"] == {"sign_in_required": 1}
    assert score == 1.0


def test_a_genuine_stop_is_still_counted():
    # The exclusion list must not become a way to launder real failures.
    report = {"listings": [
        {"tier": "A", "target": "https://x", "host_class": "employer",
         "dry_run": {"outcome": "unanswered_required", "answers_total": 2}},
    ]}
    score, detail = apply_score._fillability(report)
    assert detail["graded"] == 1
    assert detail["submit_ready"] == 0
    assert score == 0.0


class FakePage:
    """A page that reports whatever error nodes the test wants."""

    def __init__(self, said="", has_error=True):
        self.said = said
        self.has_error = has_error

    def query_selector(self, sel):
        # No success selector ever matches; the error hints all do.
        return object() if self.has_error and "confirm" not in sel.lower() else None

    def evaluate(self, script, *args):
        return self.said


def test_a_rejection_quotes_the_form_rather_than_ourselves():
    # "page shows a validation/error message" was the entire reason recorded for
    # six real rejected applications. It cannot tell an unfilled dropdown from a
    # refused upload, so every one needed a live re-enactment to diagnose.
    import safety

    status, why = safety.classify_submit(
        FakePage("Country This field is required | Resume Please attach a file"), []
    )
    assert status == safety.APPLY_STATUS.FAILED
    assert "This field is required" in why


def test_a_rejection_we_cannot_read_still_says_so_plainly():
    import safety

    status, why = safety.classify_submit(FakePage(""), [])
    assert status == safety.APPLY_STATUS.FAILED
    assert "validation" in why


def test_validation_text_survives_a_page_that_throws():
    import safety

    class Broken:
        def evaluate(self, *a, **k):
            raise RuntimeError("page is gone")

    assert safety.validation_text(Broken()) == ""
