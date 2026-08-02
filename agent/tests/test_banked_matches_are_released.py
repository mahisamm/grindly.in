"""A banked match must eventually send itself, or the queue is write-only.

The pipeline banks any match it cannot send the instant it finds one — the
daily cap was reached, the send window had shut, a gate held the run. Those rows
are stored as 'matched' with a scheduled_for.

Only 'approved' rows are ever drained and sent, and until now nothing but a
human tapping a button promoted a row from one status to the other. So banked
matches sat there forever. Measured on 2026-08-02: fourteen applications, every
one routed to a real employer form, five of them due that morning, and not one
reachable by any code path in the system.

Nothing looked wrong. The dashboard showed rows marked "matched" and the run
funnel read banked_for_user=14 — precisely what a healthy pipeline looks like.

Standing consent is the approval. A user with auto-apply on and current consent
has already said "send these for me"; a per-row tap on top of that is the exact
thing this product exists to remove.
"""
import os
import sqlite3
import time

import pytest

import db

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "release.db")
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    c.commit()
    c.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _real_conn(path))
    monkeypatch.setattr(db, "cuid", lambda: "c" + os.urandom(12).hex())
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    monkeypatch.setattr(db, "time_ago_db", lambda ms: int(time.time() * 1000) - ms)
    with db.conn() as c:
        c.execute("INSERT INTO users (id, email, plan, status, created_at) "
                  "VALUES (?,?,?,?,?)", ("u1", "u1@x.com", "free", "active", 0))
    return path


def _bank(app_id, tier="A", due_ms=None, status="matched", score=80):
    with db.conn() as c:
        db._ensure_app_columns(c)
        c.execute(
            "INSERT INTO applications (id, user_id, job_id, job_title, company, "
            "url, match_score, status, apply_tier, apply_channel, scheduled_for, "
            "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (app_id, "u1", None, "Intern", "Acme", f"https://acme.test/{app_id}",
             score, status, tier, "ats",
             db.now_db() - 1000 if due_ms is None else due_ms, 0),
        )


def _status(app_id):
    with db.conn() as c:
        r = c.execute("SELECT status FROM applications WHERE id=?", (app_id,)).fetchone()
    return r["status"]


def test_a_due_banked_match_is_released_for_sending(testdb):
    _bank("a1")
    assert db.release_due_matches("u1", limit=5) == 1
    assert _status("a1") == "approved"


def test_a_released_row_reaches_the_queue_that_actually_sends(testdb):
    """The drain reads status='approved'. A release that did not land there
    would look like it worked and still send nothing."""
    _bank("a1")
    db.release_due_matches("u1", limit=5)
    assert [a["id"] for a in db.get_approved_applications("u1")] == ["a1"]


def test_a_match_that_is_not_due_yet_stays_banked(testdb):
    """The pipeline paces applications across days on purpose. Releasing early
    would empty a month of queue into one morning."""
    _bank("future", due_ms=db.now_db() + 86_400_000)
    assert db.release_due_matches("u1", limit=5) == 0
    assert _status("future") == "matched"


def test_only_tier_a_is_released(testdb):
    """Tier A's whole definition is that no account of the user's is at stake.
    A board row lives behind their login and keeps its own consent path."""
    _bank("tierA", tier="A")
    _bank("tierB", tier="B")
    _bank("tierC", tier="C")
    assert db.release_due_matches("u1", limit=9) == 1
    assert _status("tierA") == "approved"
    assert _status("tierB") == "matched"
    assert _status("tierC") == "matched"


def test_the_release_is_bounded_by_the_remaining_daily_quota(testdb):
    for i in range(10):
        _bank(f"a{i}")
    assert db.release_due_matches("u1", limit=3) == 3
    assert sum(1 for i in range(10) if _status(f"a{i}") == "approved") == 3


def test_no_quota_left_releases_nothing(testdb):
    _bank("a1")
    assert db.release_due_matches("u1", limit=0) == 0
    assert _status("a1") == "matched"


def test_the_longest_waiting_match_goes_first(testdb):
    """Due order before score. The pipeline assigned those dates to pace a
    user's applications across days, so a row that came due on Monday goes
    before one that came due on Tuesday even if Tuesday's scores higher —
    otherwise a strong match arriving later would keep jumping the queue and
    the earlier one would starve."""
    now = db.now_db()
    _bank("waited_longer", score=70, due_ms=now - 90_000)
    _bank("newer_but_better", score=95, due_ms=now - 1_000)
    db.release_due_matches("u1", limit=1)
    assert _status("waited_longer") == "approved"
    assert _status("newer_but_better") == "matched"


def test_score_breaks_a_tie_between_equally_due_matches(testdb):
    now = db.now_db()
    _bank("low", score=70, due_ms=now - 5_000)
    _bank("high", score=95, due_ms=now - 5_000)
    db.release_due_matches("u1", limit=1)
    assert _status("high") == "approved"
    assert _status("low") == "matched"


def test_rows_in_other_states_are_untouched(testdb):
    """A skip is a judgement and a failure is a record. Neither is a pending
    application, and releasing either would re-send or resurrect it."""
    for state in ("skipped", "failed", "applied", "needs_review"):
        _bank(state, status=state)
    assert db.release_due_matches("u1", limit=9) == 0
    for state in ("skipped", "failed", "applied", "needs_review"):
        assert _status(state) == state
