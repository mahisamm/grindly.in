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


def test_discovery_is_not_gated_by_the_hour():
    """Only sending waits for morning. A run that refused to discover at 2am
    would hand a late-night user a blank dashboard."""
    import inspect

    src = inspect.getsource(worker.run_for_user)
    hold = src.split("if live and not _in_human_hours(ist_h):", 1)[1][:400]
    assert "remaining = 0" in hold, "the hold must zero the send budget"
    assert "return" not in hold.split("submit_paused_for_hours")[0], \
        "the hold must not abandon the run — discovery continues"


def test_a_held_match_is_not_labelled_a_cap_problem():
    """"Daily cap reached" on a 1am run is untrue: the cap is untouched, the
    clock is the reason, and the user would go hunting a quota bug."""
    import inspect

    src = inspect.getsource(worker.run_for_user)
    assert "found overnight, goes out after" in src
