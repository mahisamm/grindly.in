"""The daily cap, enforced as a reservation.

The property that matters: N workers racing can never produce cap+1 submitted
applications. Counting rows and then deciding cannot give that — two workers
both read 4-of-5, both conclude there is room, and both send. A sent
application cannot be recalled, so the database has to be the arbiter.
"""
import os
import sqlite3
import threading
import time

import pytest

import db


SCHEMA = """
CREATE TABLE daily_usage (
    id TEXT PRIMARY KEY, user_id TEXT, local_date TEXT,
    submitted INTEGER DEFAULT 0, attempted INTEGER DEFAULT 0, updated_at INTEGER
);
CREATE UNIQUE INDEX daily_usage_user_date ON daily_usage(user_id, local_date);
CREATE TABLE application_events (
    id TEXT PRIMARY KEY, application_id TEXT, type TEXT, actor TEXT,
    meta TEXT, created_at INTEGER
);
"""


@pytest.fixture()
def capdb(tmp_path, monkeypatch):
    from contextlib import contextmanager

    path = str(tmp_path / "cap.db")
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    c.commit()
    c.close()

    @contextmanager
    def _conn():
        con = sqlite3.connect(path, timeout=15)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA busy_timeout = 8000")
            yield con
            con.commit()
        finally:
            con.close()

    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _conn)
    monkeypatch.setattr(db, "cuid", lambda: "c" + os.urandom(8).hex())
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    return path


def test_a_slot_can_be_reserved_up_to_the_cap(capdb):
    assert [db.reserve_daily_slot("u1", 3) for _ in range(3)] == [True, True, True]
    assert db.daily_usage("u1")["submitted"] == 3


def test_the_cap_refuses_the_next_one(capdb):
    for _ in range(3):
        db.reserve_daily_slot("u1", 3)
    assert db.reserve_daily_slot("u1", 3) is False
    assert db.daily_usage("u1")["submitted"] == 3


def test_a_zero_cap_grants_nothing(capdb):
    assert db.reserve_daily_slot("u1", 0) is False


def test_concurrent_workers_can_never_exceed_the_cap(capdb):
    """The acceptance test from the spec. Ten threads race for five slots; the
    database must hand out exactly five."""
    cap, granted, lock = 5, [], threading.Lock()

    def worker():
        ok = db.reserve_daily_slot("u1", cap)
        with lock:
            granted.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(granted) == cap, f"handed out {sum(granted)} slots for a cap of {cap}"
    assert db.daily_usage("u1")["submitted"] == cap


def test_users_hold_separate_allowances(capdb):
    assert db.reserve_daily_slot("u1", 1) is True
    assert db.reserve_daily_slot("u2", 1) is True, "one user's cap must not spend another's"
    assert db.reserve_daily_slot("u1", 1) is False


def test_releasing_a_slot_returns_it_to_the_day(capdb):
    db.reserve_daily_slot("u1", 1)
    assert db.reserve_daily_slot("u1", 1) is False
    db.release_daily_slot("u1")
    assert db.reserve_daily_slot("u1", 1) is True


def test_release_keeps_the_attempt_on_record(capdb):
    """`attempted` is the audit trail of reservations taken; only `submitted`
    is refundable."""
    db.reserve_daily_slot("u1", 2)
    db.release_daily_slot("u1")
    usage = db.daily_usage("u1")
    assert usage["submitted"] == 0
    assert usage["attempted"] == 1


def test_release_never_drives_the_count_negative(capdb):
    db.release_daily_slot("u1")
    assert db.daily_usage("u1")["submitted"] == 0


def test_the_day_is_the_users_local_day(capdb):
    """"5 a day" has to mean the user's day. An IST user's allowance must not
    reset at 05:30 local because UTC rolled over."""
    ist = db.local_date_for("u1", "Asia/Kolkata")
    assert len(ist) == 10 and ist.count("-") == 2
    assert db.local_date_for("u1", "Not/AZone") == db.local_date_for("u1", None), \
        "an unknown zone must fall back, never raise"


def test_an_event_write_never_breaks_the_caller(capdb):
    db.add_application_event("app1", "submitted", actor="worker", meta={"channel": "ats"})
    with db.conn() as c:
        row = c.execute("SELECT * FROM application_events WHERE application_id='app1'").fetchone()
    assert row["type"] == "submitted" and row["actor"] == "worker"
    # A bad row must be swallowed, not raised: a timeline write is never worth
    # failing a real submission over.
    db.add_application_event(None, "x")  # type: ignore[arg-type]
