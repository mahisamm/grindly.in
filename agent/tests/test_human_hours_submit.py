"""Nothing is submitted outside human hours, however the run was started.

The defer in run_for_user only catches manual=False, and run_job hands EVERY
queued job manual=True — so the daily sweep, the "Run agent" tap and the
spread-mode requeue all sailed past it. Measured live: a scheduled run
submitted an application to a real employer at 01:13 IST, which is the exact
round-the-clock pattern the rule exists to avoid, on a board that holds the
user's own login.

Discovery at any hour is fine and must stay fine: banking matches at 2am
carries none of that risk, and a user who taps "Run agent" late gets results
instead of a blank screen.
"""
import worker


def test_the_window_itself():
    assert worker._in_human_hours(worker.HUMAN_HOURS_START)
    assert not worker._in_human_hours(worker.HUMAN_HOURS_START - 1)
    assert not worker._in_human_hours(worker.HUMAN_HOURS_END)
    assert worker._in_human_hours(worker.HUMAN_HOURS_END - 1)


def test_one_am_is_outside_the_window():
    """The measured failure: 01:13 IST."""
    assert not worker._in_human_hours(1)


def test_every_queued_job_still_runs_as_manual():
    """This is WHY the submit gate cannot key on `manual`. If this ever
    changes, the comment in run_for_user needs revisiting — but the submit
    gate stays correct either way, which is the point of not keying on it."""
    import inspect

    src = inspect.getsource(worker.run_job)
    assert "manual=True" in src


def test_the_submit_gate_does_not_depend_on_manual():
    """A gate that trusted `manual` would be bypassed by every queued run."""
    import inspect

    src = inspect.getsource(worker.run_for_user)
    gate = [ln for ln in src.splitlines() if "_in_human_hours(ist_h)" in ln]
    # Two checks: the legacy defer (keys on manual) and the submit hold (must not).
    assert len(gate) >= 2, "the submit-hours hold is missing"
    submit_hold = [ln for ln in gate if "not manual" not in ln]
    assert submit_hold, "every human-hours check still keys on `manual`"


def test_the_hold_yields_rather_than_banking_with_a_zero_budget():
    """The regression this replaced. Walking the apply loop with remaining=0
    banked every deliverable match with a pipeline release date DAYS out, and a
    banked match is never auto-sent later — only freshly discovered ones are
    dispatched inline. Four sendable Internshala matches were filed for
    2026-08-02 under "goes out after 9:00 IST", a promise nothing kept."""
    import inspect

    src = inspect.getsource(worker.run_for_user)
    hold = src.split("if live and not _in_human_hours(ist_h):", 1)[1][:900]
    assert "_requeue_after_seconds" in hold, "the hold must yield, not bank"
    assert "remaining = 0" not in hold, "zero-budget banking is the bug"


def test_the_false_overnight_promise_is_gone():
    import inspect

    assert "found overnight, goes out after" not in inspect.getsource(worker)


# --- when the run wakes back up ---------------------------------------------

def test_the_wait_lands_inside_the_window_not_on_its_edge():
    """Waking at exactly 09:00:00 races the very check that put it to sleep,
    and losing that race costs another whole day."""
    wait = worker._seconds_until_send_window(1, 0)
    woke_at = 1 * 60 + wait // 60
    assert woke_at > worker.HUMAN_HOURS_START * 60


def test_a_late_night_run_waits_until_the_morning():
    wait = worker._seconds_until_send_window(1, 0)
    assert 7 * 3600 < wait < 9 * 3600, wait


def test_an_evening_run_waits_for_tomorrow_not_today():
    """22:00 is past the close; the next window is tomorrow morning."""
    wait = worker._seconds_until_send_window(22, 0)
    assert wait > 10 * 3600, wait


def test_inside_the_window_there_is_no_wait():
    assert worker._seconds_until_send_window(worker.HUMAN_HOURS_START + 1, 0) == 0
    assert worker._seconds_until_send_window(worker.HUMAN_HOURS_END - 1, 0) == 0


def test_the_wait_is_never_zero_just_before_opening():
    """A zero wait one minute before the window reopens the race."""
    assert worker._seconds_until_send_window(worker.HUMAN_HOURS_START, 0) >= 60
