"""agent/flags.py — the operational kill switches.

The property under test everywhere: a flag turns an executor OFF without losing
queue state, and the master outranks everything. These flags are what an
operator reaches for during an incident, so their failure mode must be boring.
"""
import pytest

import flags
import safety
import worker


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in (
        "GRINDLY_AUTOPILOT_ENABLED", "GRINDLY_DIRECT_SUBMIT_ENABLED",
        "GRINDLY_BROWSER_EXECUTOR_ENABLED", "GRINDLY_SEARCH_DISCOVERY_ENABLED",
        "GRINDLY_DAILY_REPORT_ENABLED", "GRINDLY_SOURCE_NAUKRI",
        "GRINDLY_AUTO_APPLY_MODE", "GRINDLY_TIER_B_APPLY",
    ):
        monkeypatch.delenv(name, raising=False)


# ---- defaults preserve current production behaviour -------------------------

def test_defaults_match_what_production_runs_today():
    assert flags.autopilot_enabled() is True
    assert flags.direct_submit_enabled() is True
    assert flags.daily_report_enabled() is True
    assert flags.source_enabled("internshala") is True


def test_unbuilt_executors_ship_dark():
    assert flags.browser_executor_enabled() is False
    assert flags.search_discovery_enabled() is False


# ---- the master outranks everything -----------------------------------------

def test_master_off_kills_direct_submit_even_when_its_own_flag_is_on(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTOPILOT_ENABLED", "0")
    monkeypatch.setenv("GRINDLY_DIRECT_SUBMIT_ENABLED", "1")
    assert flags.direct_submit_enabled() is False


def test_master_off_reads_as_auto_apply_off_for_tier_b(monkeypatch):
    """The one flag must silence the hosted-submit path too, or 'autopilot off'
    would still send applications under a user's Internshala account."""
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    assert safety.requires_manual_final_submit("internshala")[0] is False  # sanity: live works
    monkeypatch.setenv("GRINDLY_AUTOPILOT_ENABLED", "0")
    assert safety.auto_apply_mode() == safety.AUTO_APPLY_OFF
    assert safety.requires_manual_final_submit("internshala")[0] is True


# ---- executors hold work instead of failing it ------------------------------

def test_direct_submit_off_banks_the_destination(monkeypatch):
    """channel_deliverable=False routes the row to the matched bank, the same
    path as a sender whose own enabled() is false — nothing is spent or lost."""
    dest = {"channel": "google_form", "target": "https://docs.google.com/forms/x"}
    assert worker.channel_deliverable(dest) is True   # sanity: on by default
    monkeypatch.setenv("GRINDLY_DIRECT_SUBMIT_ENABLED", "0")
    assert worker.channel_deliverable(dest) is False


def test_board_channel_is_not_gated_by_direct_submit(monkeypatch):
    """The platform channel has its own gate (requires_manual_final_submit);
    the Tier A switch must not double-govern it."""
    monkeypatch.setenv("GRINDLY_DIRECT_SUBMIT_ENABLED", "0")
    assert worker.channel_deliverable({"channel": "platform", "target": ""}) is True


# ---- per-source switches ----------------------------------------------------

def test_one_source_can_be_dropped_without_touching_the_rest(monkeypatch):
    monkeypatch.setenv("GRINDLY_SOURCE_NAUKRI", "0")
    assert flags.source_enabled("naukri") is False
    assert flags.source_enabled("internshala") is True
    assert flags.source_enabled("indeed") is True


def test_unknown_or_empty_source_is_not_enabled():
    assert flags.source_enabled("") is False


# ---- observability ----------------------------------------------------------

def test_snapshot_reports_every_switch(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTOPILOT_ENABLED", "0")
    snap = flags.snapshot()
    assert snap["autopilot"] is False
    assert snap["direct_submit"] is False           # master cascades into the view
    assert set(snap) == {
        "autopilot", "direct_submit", "browser_executor",
        "search_discovery", "daily_report", "no_touch_only",
    }


# ---- no-touch mode ----------------------------------------------------------

def test_no_touch_mode_is_off_unless_asked_for():
    """It removes listings from the product. That is never a default."""
    assert flags.no_touch_only() is False


def test_no_touch_mode_turns_on_from_one_env_var(monkeypatch):
    monkeypatch.setenv("GRINDLY_NO_TOUCH_ONLY", "1")
    assert flags.no_touch_only() is True


# ---- no-touch mode keeps what the agent CAN finish alone --------------------
# "No touch" is a promise about the user's effort, not a synonym for "Tier A".
# Dropping every board unconditionally meant a user could finish the Internshala
# connect flow, see the dashboard say "connected", and never be shown another
# Internshala listing — because none was ever scraped again.

def test_no_touch_drops_a_board_the_user_has_not_connected(monkeypatch):
    import worker

    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    assert worker._no_touch_boards(["internshala"], []) == []


def test_no_touch_keeps_a_connected_board_the_agent_may_submit_to(monkeypatch):
    import worker

    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    assert worker._no_touch_boards(["internshala"], ["internshala"]) == ["internshala"]


def test_no_touch_still_drops_tier_c_even_when_connected(monkeypatch):
    """LinkedIn/Naukri/Indeed/Unstop are never submitted from our servers, so a
    session on one buys the user nothing but a queue of taps."""
    import worker

    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    boards = ["linkedin", "naukri", "indeed", "unstop"]
    assert worker._no_touch_boards(boards, boards) == []


def test_no_touch_drops_a_connected_board_while_tier_b_is_switched_off(monkeypatch):
    import worker

    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.delenv("GRINDLY_TIER_B_APPLY", raising=False)
    assert worker._no_touch_boards(["internshala"], ["internshala"]) == []


def test_connected_platform_names_match_case_insensitively(monkeypatch):
    import worker

    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    assert worker._no_touch_boards(["internshala"], ["Internshala"]) == ["internshala"]
