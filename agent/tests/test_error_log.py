"""Recording a crash must never cause one.

The worker's error handling is deliberately local — a dead board never fails a
sweep — which meant every failure lived only in a container log that rotates and
that nobody reads until a user complains. This writes them to the database
instead. Everything here is about the one property that matters: an error logger
that raises turns a handled failure into an outage.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import error_log


def test_the_same_fault_from_the_same_place_is_one_row():
    a = error_log.fingerprint("worker", "TimeoutError", "page.goto timed out")
    b = error_log.fingerprint("worker", "TimeoutError", "page.goto timed out")
    assert a == b


def test_the_workers_crash_is_not_the_browsers():
    # Same words, different half of the product, different fix.
    assert error_log.fingerprint("worker", "TypeError", "x is not a function") != \
        error_log.fingerprint("browser", "TypeError", "x is not a function")


def test_the_fingerprint_matches_the_web_writer():
    # src/lib/errorLog.ts computes the same sha1. The two processes write to ONE
    # table; disagreeing would file the same fault twice and make counts wrong.
    assert error_log.fingerprint("worker", "ValueError", "boom") == \
        "a74e286e3ab68bdaabeed6919347886cb7f466ba"


def test_capture_never_raises_when_the_database_is_gone(monkeypatch):
    # The single most important property. This runs inside `except` blocks all
    # over the worker; a throw here replaces a handled error with an unhandled
    # one, mid-run, with a daily slot possibly reserved.
    def dead(*a, **k):
        raise RuntimeError("no database")

    monkeypatch.setattr(error_log.db, "conn", dead)
    error_log.capture(ValueError("boom"), context={"job": "j1"})


def test_recent_returns_nothing_rather_than_raising(monkeypatch):
    def dead(*a, **k):
        raise RuntimeError("no database")

    monkeypatch.setattr(error_log.db, "conn", dead)
    assert error_log.recent() == []


def test_a_long_trace_is_cut_before_it_is_stored(monkeypatch):
    # A full trace of a deep framework call is kilobytes per occurrence, and the
    # top frames are the only part anyone reads.
    written = {}

    class FakeConn:
        def execute(self, sql, params):
            written["params"] = params
            return self

        def commit(self):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(error_log.db, "conn", lambda: FakeConn())
    error_log.capture(ValueError("x" * 5000))
    message, stack = written["params"][4], written["params"][5]
    assert len(message) <= error_log.MAX_MESSAGE
    assert len(stack) <= error_log.MAX_STACK
