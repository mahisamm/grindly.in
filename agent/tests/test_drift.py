"""Tests for the selector-drift detector (agent/drift.py)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import drift


def test_selector_heavy_failures_alert():
    r = drift.assess_source("linkedin", attempts=10, reasons=["selector_missing"] * 7)
    assert r.alert is True
    assert r.kind == "selector_drift"
    assert r.selector_failures == 7
    assert 0.6 < r.selector_share < 0.8
    assert "Selector drift" in r.message()


def test_transient_failures_do_not_alert():
    # Same number of failures, but all captcha/session — the site/user, not us.
    r = drift.assess_source(
        "internshala", attempts=10, reasons=["captcha", "session_expired"] * 4
    )
    assert r.alert is False
    assert r.selector_failures == 0
    assert r.kind == "healthy"


def test_small_sample_never_alerts():
    r = drift.assess_source("naukri", attempts=3, reasons=["selector_missing"] * 3)
    assert r.alert is False
    assert r.kind == "insufficient_sample"


def test_below_threshold_selector_failures_flagged_but_no_alert():
    r = drift.assess_source("indeed", attempts=10, reasons=["selector_missing"] * 2)
    assert r.alert is False
    assert r.kind == "other_failures"
    assert r.selector_failures == 2


def test_assess_sorts_alerting_sources_first():
    stats = {
        "healthy": {"attempts": 8, "reasons": ["timeout"]},
        "broken": {"attempts": 8, "reasons": ["selector_missing"] * 6},
    }
    reports = drift.assess(stats)
    assert reports[0].source == "broken"
    assert reports[0].alert is True
    assert reports[1].alert is False


def test_custom_min_attempts_matches_worker_wiring():
    # Worker passes min_attempts=3 to match its existing >=3 gate.
    r = drift.assess_source("linkedin", attempts=4, reasons=["selector_missing"] * 3, min_attempts=3)
    assert r.alert is True
