"""The daily sweep. Two properties matter: it must actually fire (nothing enqueued
runs before this existed, so "your agent applies daily" was false), and it must not
fire for everyone at once (that is a fleet-wide pattern no amount of per-run pacing
can hide)."""
import datetime
from unittest.mock import patch

import sweep


def _ist(hour: int, day: int = 14) -> datetime.datetime:
    return datetime.datetime(2026, 7, day, hour, 0, tzinfo=datetime.timezone.utc)


# --- the hour is spread across the fleet -------------------------------------

def test_every_user_lands_inside_the_working_window():
    for i in range(200):
        h = sweep.sweep_hour(f"user{i}", "2026-07-14")
        assert sweep.SWEEP_HOUR_START <= h <= sweep.SWEEP_HOUR_END


def test_the_whole_fleet_is_not_swept_in_the_same_hour():
    """If every user swept at 09:00 we would hit Internshala with the entire fleet
    in one minute each morning, from one IP block. No amount of careful pacing
    inside an individual run hides that."""
    hours = {sweep.sweep_hour(f"user{i}", "2026-07-14") for i in range(200)}
    assert len(hours) >= 5


def test_a_users_hour_is_stable_within_the_day():
    """Restarting the container must not reroll the hour — that could fire a second
    sweep for a user who was already done."""
    a = sweep.sweep_hour("u1", "2026-07-14")
    b = sweep.sweep_hour("u1", "2026-07-14")
    assert a == b


def test_a_users_hour_moves_between_days():
    hours = {sweep.sweep_hour("u1", f"2026-07-{d:02d}") for d in range(1, 29)}
    assert len(hours) > 1


# --- who is due --------------------------------------------------------------

def test_a_user_is_not_due_before_their_hour():
    hour = sweep.sweep_hour("u1", "2026-07-14")
    with patch.object(sweep.db, "active_users", return_value=["u1"]), \
         patch.object(sweep.db, "get_user_plan", return_value="free"), \
         patch.object(sweep.db, "live_runs_today", return_value=0):
        assert sweep.due_users(_ist(hour - 1)) == []
        assert sweep.due_users(_ist(hour)) == ["u1"]


def test_a_user_who_already_ran_today_is_skipped():
    """Otherwise a container restart re-enqueues the entire fleet."""
    with patch.object(sweep.db, "active_users", return_value=["u1"]), \
         patch.object(sweep.db, "get_user_plan", return_value="free"), \
         patch.object(sweep.db, "live_runs_today", return_value=1):
        assert sweep.due_users(_ist(23)) == []


def test_only_active_users_are_swept():
    with patch.object(sweep.db, "active_users", return_value=[]), \
         patch.object(sweep.db, "live_runs_today", return_value=0):
        assert sweep.due_users(_ist(23)) == []


# --- pro gets two passes a day ------------------------------------------------

def test_pro_gets_two_slot_hours_and_others_get_one():
    hours = sweep.sweep_hours("u1", "2026-07-14", "pro")
    assert len(hours) == 2
    assert hours[0] < hours[1]
    assert all(sweep.SWEEP_HOUR_START <= h <= sweep.SWEEP_HOUR_END for h in hours)
    assert len(sweep.sweep_hours("u1", "2026-07-14", "free")) == 1
    assert len(sweep.sweep_hours("u1", "2026-07-14", "plus")) == 1


def test_pro_afternoon_slot_fires_exactly_once():
    """After the morning run, a pro user is due again at the second hour — and
    once that second run exists, they are done for the day. The count contract
    is what a restart cannot double-fire."""
    h1, h2 = sweep.sweep_hours("u1", "2026-07-14", "pro")
    with patch.object(sweep.db, "active_users", return_value=["u1"]), \
         patch.object(sweep.db, "get_user_plan", return_value="pro"):
        with patch.object(sweep.db, "live_runs_today", return_value=0):
            assert sweep.due_users(_ist(h1)) == ["u1"]
        with patch.object(sweep.db, "live_runs_today", return_value=1):
            assert sweep.due_users(_ist(h1)) == []
            assert sweep.due_users(_ist(h2)) == ["u1"]
        with patch.object(sweep.db, "live_runs_today", return_value=2):
            assert sweep.due_users(_ist(23)) == []


def test_pro_slot_hours_are_stable_within_the_day():
    assert sweep.sweep_hours("u1", "2026-07-14", "pro") == \
        sweep.sweep_hours("u1", "2026-07-14", "pro")


# --- enqueueing --------------------------------------------------------------

def test_tick_enqueues_a_live_run_for_each_due_user():
    with patch.object(sweep, "due_users", return_value=["u1", "u2"]), \
         patch.object(sweep.run_queue, "enqueue") as enq, \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "active_users", return_value=[]):
        assert sweep.tick() == 2
    assert [c.args for c in enq.call_args_list] == [("u1", "live"), ("u2", "live")]


def test_one_users_failure_does_not_stop_the_rest_of_the_fleet():
    def flaky(uid, mode):
        if uid == "u1":
            raise RuntimeError("db blip")

    with patch.object(sweep, "due_users", return_value=["u1", "u2"]), \
         patch.object(sweep.run_queue, "enqueue", side_effect=flaky), \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "active_users", return_value=[]):
        assert sweep.tick() == 1   # u2 still got swept


def test_tick_enqueues_a_delivery_run_for_a_due_unnotified_link():
    with patch.object(sweep, "due_users", return_value=[]), \
         patch.object(sweep.db, "active_users", return_value=["u1"]), \
         patch.object(sweep.db, "has_due_unnotified_match", return_value=True), \
         patch.object(sweep.run_queue, "enqueue") as enq:
        assert sweep.tick() == 1
    assert enq.call_args.args == ("u1", "deliver")


# --- opt-in gmail interview scan ---------------------------------------------

def test_scan_not_enqueued_when_feature_is_off(monkeypatch):
    """With the flag off (the production default), the sweep never even looks at a
    user's Gmail credential, let alone queues a scan."""
    monkeypatch.delenv("GMAIL_SCAN_ENABLED", raising=False)
    with patch.object(sweep, "due_users", return_value=["u1"]), \
         patch.object(sweep.run_queue, "enqueue") as enq, \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "get_platform_credential") as cred, \
         patch.object(sweep.db, "active_users", return_value=[]):
        sweep.tick()
        cred.assert_not_called()
        assert [c.args[1] for c in enq.call_args_list] == ["live"]


def test_scan_enqueued_once_for_a_gmail_user_when_enabled(monkeypatch):
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")
    with patch.object(sweep, "due_users", return_value=["u1"]), \
         patch.object(sweep.run_queue, "enqueue") as enq, \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "get_platform_credential", return_value="cipher"), \
         patch.object(sweep.db, "active_users", return_value=[]):
        n = sweep.tick()
        modes = [c.args[1] for c in enq.call_args_list]
        assert modes == ["live", "scan_email"]  # same daily cadence, one each
        assert n == 2


def test_scan_not_enqueued_for_a_user_without_gmail(monkeypatch):
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")
    with patch.object(sweep, "due_users", return_value=["u1"]), \
         patch.object(sweep.run_queue, "enqueue") as enq, \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "get_platform_credential", return_value=None), \
         patch.object(sweep.db, "active_users", return_value=[]):
        sweep.tick()
        assert [c.args[1] for c in enq.call_args_list] == ["live"]


def test_a_scan_enqueue_failure_does_not_break_the_sweep(monkeypatch):
    """A hiccup queuing the scan must not disturb the live run already queued."""
    monkeypatch.setenv("GMAIL_SCAN_ENABLED", "1")

    def flaky(uid, mode):
        if mode == "scan_email":
            raise RuntimeError("queue blip")

    with patch.object(sweep, "due_users", return_value=["u1"]), \
         patch.object(sweep.run_queue, "enqueue", side_effect=flaky), \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "get_platform_credential", return_value="cipher"), \
         patch.object(sweep.db, "active_users", return_value=[]):
        assert sweep.tick() == 1  # the live run still counts
