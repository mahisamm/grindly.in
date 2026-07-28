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


# ---------- the daily report is once per local day ----------

def test_a_second_run_the_same_day_does_not_re_announce(capdb):
    """A sweep runs several times a day (scheduler + every "Run now"). Each pass
    delivering its own "daily" report meant one user got three different
    summaries before lunch, which reads as a malfunction rather than a service."""
    with db.conn() as c:
        c.execute("""CREATE TABLE reports (
            id TEXT PRIMARY KEY, user_id TEXT, date TEXT, matched_count INTEGER,
            applied_count INTEGER, failed_count INTEGER, summary TEXT,
            delivered INTEGER, created_at INTEGER)""")

    assert db.report_already_sent("u1", "2026-07-26") is False
    db.add_report("u1", date="2026-07-26", matched=3, applied=1, failed=0,
                  summary="s", delivered=True)
    assert db.report_already_sent("u1", "2026-07-26") is True
    # A new day is a new report.
    assert db.report_already_sent("u1", "2026-07-27") is False
    # And one user's report never silences another's.
    assert db.report_already_sent("u2", "2026-07-26") is False


def test_an_undelivered_report_does_not_count_as_announced(capdb):
    """delivered=False means the user never actually heard about it, so the next
    run must still try."""
    with db.conn() as c:
        c.execute("""CREATE TABLE reports (
            id TEXT PRIMARY KEY, user_id TEXT, date TEXT, matched_count INTEGER,
            applied_count INTEGER, failed_count INTEGER, summary TEXT,
            delivered INTEGER, created_at INTEGER)""")
    db.add_report("u1", date="2026-07-26", matched=1, applied=0, failed=0,
                  summary="s", delivered=False)
    assert db.report_already_sent("u1", "2026-07-26") is False


def test_a_broken_reports_table_never_blocks_the_report(capdb):
    """This check must never be the reason a user hears nothing."""
    assert db.report_already_sent("u1", "2026-07-26") is False


# ---------- the browser executor needs something to claim --------------------

def test_a_board_application_is_queued_for_the_users_browser(capdb):
    """The producer the extension consumes.

    The whole executor — claim API, leases, gate detection — shipped complete
    and switched on, and did nothing at all, because nothing ever created a
    BrowserTask. The queue was empty by construction, so the extension polled
    forever and correctly found no work."""
    tid = db.enqueue_browser_task("u1", "app1", "https://internshala.com/internship/detail/x")
    assert tid, "a board application must become claimable work"
    with db.conn() as c:
        row = c.execute("SELECT * FROM browser_tasks WHERE id=?", (tid,)).fetchone()
    assert row["state"] == "queued"
    assert row["host"] == "internshala.com", "scoped to one host, so a leaked lease cannot roam"


def test_the_same_application_is_never_queued_twice(capdb):
    """A sweep runs many times a day; each pass must not pile up duplicates of
    the same application for the same browser."""
    first = db.enqueue_browser_task("u1", "app1", "https://internshala.com/x")
    second = db.enqueue_browser_task("u1", "app1", "https://internshala.com/x")
    assert first == second
    with db.conn() as c:
        assert c.execute("SELECT count(*) n FROM browser_tasks").fetchone()["n"] == 1


def test_a_url_with_no_host_is_not_queued(capdb):
    """Nothing to navigate to, and a task scoped to an empty host would be a
    task scoped to anywhere."""
    assert db.enqueue_browser_task("u1", "app1", "not-a-url") is None


def test_queueing_never_raises(capdb):
    """Extra work is never worth failing a run over."""
    assert db.enqueue_browser_task("u1", "", "https://x.com/1") is None


def test_a_refused_server_send_falls_back_to_the_users_browser(capdb, monkeypatch):
    """The VPS is a datacenter IP with no session; ATS portals routinely answer
    it with a human-check. The user's own signed-in browser never sees that
    check — so a refusal at the door must become a browser task, or web-found
    employer applications only ever retry from the one place that cannot pass."""
    import resolver
    import worker

    monkeypatch.setenv("GRINDLY_BROWSER_EXECUTOR_ENABLED", "1")
    dest = resolver.destination(
        channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
        target="https://boards.greenhouse.io/acme/jobs/1", vendor="greenhouse",
        evidence="test",
    )
    queued = worker._queue_browser_task(
        "u1", dest, "https://acme.com/careers/1", True, application_id="app1",
    )
    assert queued is True
    with db.conn() as c:
        row = c.execute("SELECT url, host, state FROM browser_tasks").fetchone()
    # The browser gets the RESOLVED application form, not the listing page.
    assert row["url"] == "https://boards.greenhouse.io/acme/jobs/1"
    assert row["host"] == "boards.greenhouse.io"
    assert row["state"] == "queued"


def test_no_fallback_without_the_users_readiness(capdb, monkeypatch):
    """The executor acts under the user's name in their browser — an unready or
    unconsented profile must gate the fallback exactly like the bank branch."""
    import resolver
    import worker

    monkeypatch.setenv("GRINDLY_BROWSER_EXECUTOR_ENABLED", "1")
    dest = resolver.destination(
        channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
        target="https://boards.greenhouse.io/acme/jobs/1", vendor="greenhouse",
        evidence="test",
    )
    # False, and it returns before any DB write — this test db has no
    # browser_tasks table at all, so a write attempt would raise, not queue.
    assert worker._queue_browser_task(
        "u1", dest, "https://acme.com/careers/1", False, application_id="app1",
    ) is False
