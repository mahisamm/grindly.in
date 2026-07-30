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
