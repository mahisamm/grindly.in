"""The daily sweep. Two properties matter: it must actually fire (nothing enqueued
runs before this existed, so "your agent applies daily" was false), and it must not
fire for everyone at once (that is a fleet-wide pattern no amount of per-run pacing
can hide)."""
import datetime
from unittest.mock import patch

import pytest

import sweep


def _ist(hour: int, day: int = 14) -> datetime.datetime:
    return datetime.datetime(2026, 7, day, hour, 0, tzinfo=datetime.timezone.utc)


@pytest.fixture(autouse=True)
def _no_live_harvest():
    """tick() ends with the fleet-wide board harvest, which issues a few
    hundred real searches. Without this the existing tick tests quietly went to
    the network — one took 137 seconds and would fail on a plane, or hammer the
    production search backend from anyone's laptop.

    Every test starts from "today's harvest has not run", so ordering between
    tests cannot decide whether one fires.
    """
    sweep._last_harvest_date = None
    with patch.object(sweep, "HARVEST_ENABLED", False):
        yield
    sweep._last_harvest_date = None


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


# --- the fleet-wide board harvest --------------------------------------------

def test_the_harvest_does_not_run_before_its_hour():
    with patch.object(sweep, "HARVEST_ENABLED", True):
        assert not sweep.harvest_due(_ist(sweep.HARVEST_HOUR - 1))
        assert sweep.harvest_due(_ist(sweep.HARVEST_HOUR))


def test_the_harvest_runs_once_a_day_not_once_per_tick():
    """The sweep loop ticks every ten minutes. A harvest per tick would issue
    its whole search budget 100+ times a day from one IP."""
    with patch.object(sweep, "HARVEST_ENABLED", True), \
         patch.object(sweep.db, "add_audit"), \
         patch("harvester.sweep", return_value={
             "learned": 2, "candidates": 5, "known_after": 500}) as h:
        assert sweep.run_harvest(_ist(sweep.HARVEST_HOUR)) is not None
        assert sweep.run_harvest(_ist(sweep.HARVEST_HOUR + 1)) is None
        assert sweep.run_harvest(_ist(sweep.HARVEST_HOUR + 5)) is None
    assert h.call_count == 1


def test_a_failed_harvest_is_not_retried_all_day():
    """It has already spent its search budget. Retrying every ten minutes is
    how one bad afternoon becomes a rate-limited IP."""
    with patch.object(sweep, "HARVEST_ENABLED", True), \
         patch("harvester.sweep", side_effect=RuntimeError("engines down")) as h:
        assert sweep.run_harvest(_ist(sweep.HARVEST_HOUR)) is None
        assert sweep.run_harvest(_ist(sweep.HARVEST_HOUR + 1)) is None
    assert h.call_count == 1


def test_a_failed_harvest_never_stops_the_users_runs():
    """The fleet's runs matter more than the index growing today."""
    with patch.object(sweep, "HARVEST_ENABLED", True), \
         patch.object(sweep, "due_users", return_value=["u1"]), \
         patch.object(sweep.run_queue, "enqueue"), \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "active_users", return_value=[]), \
         patch("harvester.sweep", side_effect=RuntimeError("boom")):
        assert sweep.tick(_ist(sweep.HARVEST_HOUR)) == 1


def test_users_are_enqueued_before_the_slow_harvest_starts():
    """The harvest takes minutes; an enqueue takes milliseconds. A wedged
    search backend must never delay somebody's agent starting."""
    order = []
    with patch.object(sweep, "HARVEST_ENABLED", True), \
         patch.object(sweep, "due_users", return_value=["u1"]), \
         patch.object(sweep.run_queue, "enqueue",
                      side_effect=lambda *a, **k: order.append("enqueue")), \
         patch.object(sweep.db, "add_audit"), \
         patch.object(sweep.db, "active_users", return_value=[]), \
         patch("harvester.sweep",
               side_effect=lambda *a, **k: order.append("harvest") or {
                   "learned": 0, "candidates": 0, "known_after": 1}):
        sweep.tick(_ist(sweep.HARVEST_HOUR))
    assert order == ["enqueue", "harvest"]


def test_the_harvest_can_be_switched_off():
    with patch.object(sweep, "HARVEST_ENABLED", False):
        assert not sweep.harvest_due(_ist(23))


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
