"""Tests for agent/run_queue.py using an in-memory SQLite DB."""
import sqlite3
import sys
import os
import threading
import time
from unittest import mock

import pytest

# Ensure agent/ is on the path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# ── minimal db stub so run_queue.py works without a real DB file ────────────
import db as _db_module

_DB_CONN = None

def _get_conn():
    global _DB_CONN
    if _DB_CONN is None:
        _DB_CONN = sqlite3.connect(":memory:", check_same_thread=False)
        _DB_CONN.row_factory = sqlite3.Row
    return _DB_CONN

class _FakeCtx:
    def __init__(self, conn):
        self._conn = conn
    def __enter__(self):
        return self._conn.cursor()
    def __exit__(self, *_):
        self._conn.commit()

def _conn_factory():
    return _FakeCtx(_get_conn())

_db_module.conn = _conn_factory
_db_module.PG = False
_db_module.now_db = lambda: int(time.time() * 1000)
_db_module.time_ago_db = lambda ms: int(time.time() * 1000) - ms
_db_module.cuid = lambda: f"cuid_{os.urandom(4).hex()}"

import run_queue


@pytest.fixture(autouse=True)
def clean_table():
    """Recreate the agent_runs table before each test."""
    c = _get_conn()
    c.execute("DROP TABLE IF EXISTS agent_runs")
    c.commit()
    yield
    c.execute("DROP TABLE IF EXISTS agent_runs")
    c.commit()


# ─── enqueue ──────────────────────────────────────────────────────────────

def test_enqueue_creates_queued_row():
    rid = run_queue.enqueue("user_1", mode="live")
    c = _get_conn()
    row = c.execute("SELECT * FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row is not None
    assert row["status"] == "queued"
    assert row["user_id"] == "user_1"
    assert row["mode"] == "live"


def test_enqueue_idempotent_returns_existing_id():
    rid1 = run_queue.enqueue("user_1")
    rid2 = run_queue.enqueue("user_1")
    assert rid1 == rid2
    c = _get_conn()
    count = c.execute("SELECT COUNT(*) FROM agent_runs WHERE user_id='user_1'").fetchone()[0]
    assert count == 1


def test_enqueue_allows_new_run_after_previous_done():
    rid1 = run_queue.enqueue("user_1")
    c = _get_conn()
    c.execute("UPDATE agent_runs SET status='done', active_key=NULL WHERE id=?", (rid1,))
    c.commit()
    rid2 = run_queue.enqueue("user_1")
    assert rid2 != rid1


def test_enqueue_allows_different_modes_for_same_user():
    live = run_queue.enqueue("user_1", "live")
    analyze = run_queue.enqueue("user_1", "analyze")
    assert live != analyze


# ─── claim_next ───────────────────────────────────────────────────────────

def test_claim_next_picks_oldest_queued():
    run_queue.enqueue("user_a")
    time.sleep(0.01)
    run_queue.enqueue("user_b")

    job = run_queue.claim_next("worker_1")
    assert job is not None
    assert job["user_id"] == "user_a"
    assert job["status"] == "running"
    assert job["locked_by"] == "worker_1"


def test_claim_next_skips_user_already_running():
    run_queue.enqueue("user_1")
    run_queue.claim_next("worker_1")   # user_1 now running

    # Enqueue user_2 — should be claimable
    run_queue.enqueue("user_2")
    job = run_queue.claim_next("worker_2")
    assert job is not None
    assert job["user_id"] == "user_2"


def test_claim_next_returns_none_when_queue_empty():
    job = run_queue.claim_next("worker_1")
    assert job is None


def test_two_workers_never_claim_same_job():
    run_queue.enqueue("user_solo")
    j1 = run_queue.claim_next("w1")
    j2 = run_queue.claim_next("w2")
    assert j1 is not None
    assert j2 is None   # queue exhausted after first claim


# ─── mark_done / mark_failed ──────────────────────────────────────────────

def test_mark_done_sets_status():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")
    assert run_queue.mark_done(rid, "w1", {"applied": 3})
    c = _get_conn()
    row = c.execute("SELECT status, result FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "done"
    import json; assert json.loads(row["result"])["applied"] == 3


def test_mark_failed_requeues_when_attempts_remain():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")   # attempts=1, max=3
    assert run_queue.mark_failed(rid, "w1", "transient error")
    c = _get_conn()
    row = c.execute("SELECT status FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "queued"   # requeued for retry


def test_mark_failed_permanently_after_max_attempts():
    rid = run_queue.enqueue("user_1")
    for attempt in range(3):
        run_queue.claim_next("w1")
        c = _get_conn()
        # Reset to queued and clear updated_at so the next claim_next() isn't
        # blocked by the post-failure backoff window — that's covered
        # separately below, not what this test is about.
        if attempt < 2:
            c.execute("UPDATE agent_runs SET status='queued', updated_at=0 WHERE id=?", (rid,))
            c.commit()
    assert run_queue.mark_failed(rid, "w1", "persistent error")
    c = _get_conn()
    row = c.execute("SELECT status FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "failed"


# ─── backoff ──────────────────────────────────────────────────────────────

def test_claim_next_skips_job_within_backoff_window():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")                      # attempts=1
    run_queue.mark_failed(rid, "w1", "transient error")    # requeued, updated_at=now
    job = run_queue.claim_next("w2")
    assert job is None   # 2min * 1 attempt backoff hasn't elapsed yet


def test_claim_next_reclaims_job_after_backoff_elapses():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")                      # attempts=1
    run_queue.mark_failed(rid, "w1", "transient error")
    c = _get_conn()
    c.execute(
        "UPDATE agent_runs SET updated_at=? WHERE id=?",
        (_db_module.now_db() - run_queue.BACKOFF_BASE_MS - 1000, rid),
    )
    c.commit()
    job = run_queue.claim_next("w2")
    assert job is not None
    assert job["attempts"] == 2


def test_claim_next_never_backoff_blocked_on_first_attempt():
    # A freshly enqueued job (attempts=0) must always be immediately claimable.
    run_queue.enqueue("user_1")
    job = run_queue.claim_next("w1")
    assert job is not None


# ─── reclaim_stale ────────────────────────────────────────────────────────

def test_reclaim_stale_requeues_crashed_jobs():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")
    # Fake a stale lock (locked_at far in the past)
    stale_ts = _db_module.now_db() - run_queue.STALE_LOCK_MS - 1000
    c = _get_conn()
    c.execute("UPDATE agent_runs SET locked_at=? WHERE id=?", (stale_ts, rid))
    c.commit()

    run_queue.reclaim_stale()
    row = c.execute("SELECT status, locked_by FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "queued"
    assert row["locked_by"] is None


def test_heartbeat_renews_only_the_owners_lease():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")
    c = _get_conn()
    old = _db_module.now_db() - run_queue.STALE_LOCK_MS - 1000
    c.execute("UPDATE agent_runs SET locked_at=? WHERE id=?", (old, rid))
    c.commit()

    assert run_queue.heartbeat(rid, "other-worker") is False
    assert run_queue.heartbeat(rid, "w1") is True
    row = c.execute("SELECT locked_at FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["locked_at"] > old


def test_claim_guarded_is_noop_on_sqlite():
    # On SQLite (PG=False) BEGIN IMMEDIATE already serialises claims, so the
    # per-user advisory guard must be a pass-through — never blocking a claim.
    assert _db_module.PG is False
    assert run_queue._claim_guarded(object(), {"user_id": "user_1"}) is True


def test_default_worker_id_is_unique_per_container_and_process(monkeypatch):
    monkeypatch.setenv("HOSTNAME", "replica-a")
    monkeypatch.setattr(run_queue.os, "getpid", lambda: 42)

    assert run_queue.default_worker_id() == "w-replica-a-42"


def test_stale_worker_cannot_finish_or_fail_a_reclaimed_job():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("old-worker")
    c = _get_conn()
    stale = _db_module.now_db() - run_queue.STALE_LOCK_MS - 1000
    c.execute("UPDATE agent_runs SET locked_at=? WHERE id=?", (stale, rid))
    c.commit()
    run_queue.reclaim_stale()
    c.execute("UPDATE agent_runs SET updated_at=0 WHERE id=?", (rid,))
    c.commit()
    run_queue.claim_next("new-worker")

    assert run_queue.mark_done(rid, "old-worker", {"applied": 99}) is False
    assert run_queue.mark_failed(rid, "old-worker", "late error") is False
    row = c.execute("SELECT status, locked_by FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "running"
    assert row["locked_by"] == "new-worker"


def test_drain_heartbeats_during_long_job(monkeypatch):
    rid = run_queue.enqueue("user_1")
    monkeypatch.setattr(run_queue, "HEARTBEAT_INTERVAL_SECONDS", 0.01)

    def slow_job(_uid, _mode):
        time.sleep(0.04)
        return {"applied": 1}

    assert run_queue.drain("worker", slow_job) == 1
    row = _get_conn().execute(
        "SELECT status, active_key FROM agent_runs WHERE id=?", (rid,)
    ).fetchone()
    assert row["status"] == "done"
    assert row["active_key"] is None


def test_drain_reschedules_paced_work_without_holding_worker():
    rid = run_queue.enqueue("user_1")

    result = run_queue.drain(
        "worker",
        lambda _uid, _mode: {"applied": 1, "_requeue_after_seconds": 60},
    )

    assert result == 1
    row = _get_conn().execute(
        "SELECT status, active_key, available_at, locked_by, attempts FROM agent_runs WHERE id=?",
        (rid,),
    ).fetchone()
    assert row["status"] == "queued"
    assert row["active_key"] == "user_1:live"
    assert row["available_at"] > _db_module.now_db()
    assert row["locked_by"] is None
    assert row["attempts"] == 0
    assert run_queue.claim_next("another-worker") is None


def test_delayed_job_becomes_claimable_when_due():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("worker")
    assert run_queue.reschedule(rid, "worker", 60)
    c = _get_conn()
    c.execute("UPDATE agent_runs SET available_at=0, updated_at=0 WHERE id=?", (rid,))
    c.commit()
    claimed = run_queue.claim_next("next-worker")
    assert claimed is not None
    assert claimed["id"] == rid


# ─── maintenance mode must never fail silently ────────────────────────────────
#
# The outage these cover: maintenance mode was left on in production, so every
# claim_next() returned None. The worker logged "serve loop as ..." once and then
# nothing for seventeen hours, while a user's resume analysis and agent run sat
# queued. The product looked broken with no error anywhere.

@pytest.fixture
def _maintenance_on(monkeypatch):
    monkeypatch.setattr(run_queue.admin_settings, "maintenance_mode", lambda: True)
    monkeypatch.setattr(run_queue, "_last_maintenance_log", 0.0)


def test_maintenance_mode_blocks_claiming(_maintenance_on):
    run_queue.enqueue("u1", "analyze")
    assert run_queue.claim_next("w1") is None


def test_maintenance_mode_warns_while_work_is_queued(_maintenance_on, caplog):
    run_queue.enqueue("u1", "analyze")
    with caplog.at_level("WARNING"):
        run_queue.claim_next("w1")
    assert any("MAINTENANCE MODE" in r.getMessage() for r in caplog.records)


def test_maintenance_mode_is_quiet_with_an_empty_queue(_maintenance_on, caplog):
    """A maintenance window with no work in it is not an incident, and must not
    train anyone to ignore the warning."""
    with caplog.at_level("WARNING"):
        run_queue.claim_next("w1")
    assert not any("MAINTENANCE MODE" in r.getMessage() for r in caplog.records)


def test_maintenance_warning_is_throttled(_maintenance_on, caplog):
    """It repeats so a later reader still sees it, but not on every 10s poll."""
    run_queue.enqueue("u1", "analyze")
    with caplog.at_level("WARNING"):
        for _ in range(5):
            run_queue.claim_next("w1")
    hits = [r for r in caplog.records if "MAINTENANCE MODE" in r.getMessage()]
    assert len(hits) == 1


# ─── the duration cap ─────────────────────────────────────────────────────

def test_a_long_lived_row_is_not_failed_for_being_old():
    """The cap used to read `created_at < now - MAX_RUN_MS`, which is the row's
    age, not the attempt's. Human-paced work yields with reschedule() and is
    re-claimed on the SAME row for hours — so once the row passed 45 minutes,
    every later attempt was force-'failed' the next time reclaim_stale ran, no
    matter that it had been executing for seconds."""
    rid = run_queue.enqueue("u1")
    c = _get_conn()
    old = _db_module.now_db() - (run_queue.MAX_RUN_MS * 3)
    c.execute("UPDATE agent_runs SET created_at=? WHERE id=?", (old, rid))
    c.commit()
    assert run_queue.claim_next("w1")["id"] == rid   # fresh attempt, right now

    run_queue.reclaim_stale()

    row = c.execute("SELECT * FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "running"
    assert row["active_key"] is not None


def test_a_wedged_attempt_still_gives_its_lease_back():
    """What the cap is actually for. The heartbeat renews locked_at every ~60s
    whether or not the run is progressing, so a wedged run never trips
    STALE_LOCK_MS on its own — the loop has to stop renewing."""
    run_queue.enqueue("u1")
    job = run_queue.claim_next("w1")
    stop = threading.Event()

    renewals = []
    real = run_queue.heartbeat
    monkey = lambda *a, **k: (renewals.append(1), real(*a, **k))[1]

    with mock.patch.object(run_queue, "heartbeat", monkey), \
         mock.patch.object(run_queue, "HEARTBEAT_INTERVAL_SECONDS", 0.01), \
         mock.patch.object(run_queue, "MAX_RUN_MS", 400):   # >> Windows timer granularity
        run_queue._heartbeat_loop(job["id"], "w1", stop)   # returns on its own

    assert renewals, "it should renew while inside the cap"
    # Renewal stopped, so locked_at now ages out and reclaim_stale takes the row.
    c = _get_conn()
    c.execute("UPDATE agent_runs SET locked_at=? WHERE id=?",
              (_db_module.now_db() - run_queue.STALE_LOCK_MS - 1, job["id"]))
    c.commit()
    run_queue.reclaim_stale()
    assert c.execute("SELECT status FROM agent_runs WHERE id=?",
                     (job["id"],)).fetchone()["status"] == "queued"


def test_a_heartbeat_blip_does_not_end_the_attempt():
    """The thread is a daemon; an exception escaping it kills the lease silently
    while run_fn keeps working, and the row gets reclaimed out from under a run
    that is still going."""
    run_queue.enqueue("u1")
    job = run_queue.claim_next("w1")
    stop = threading.Event()
    calls = []

    def flaky(rid, wid):
        calls.append(1)
        if len(calls) == 1:
            raise sqlite3.OperationalError("database is locked")
        stop.set()
        return True

    with mock.patch.object(run_queue, "heartbeat", flaky), \
         mock.patch.object(run_queue, "HEARTBEAT_INTERVAL_SECONDS", 0.01):
        run_queue._heartbeat_loop(job["id"], "w1", stop)

    assert len(calls) == 2, "it must retry on the next tick, not give up"


# ─── the loops outlive a blip ─────────────────────────────────────────────

def test_drain_runs_even_if_housekeeping_fails():
    run_queue.enqueue("u1")
    ran = []
    with mock.patch.object(run_queue, "reclaim_stale",
                           side_effect=sqlite3.OperationalError("db is locked")):
        assert run_queue.drain("w1", lambda uid, mode: ran.append(uid) or {}) == 1
    assert ran == ["u1"]


def test_serve_survives_a_drain_that_raises():
    """Letting an exception out of serve exits the worker process. Under
    Compose's restart policy that is a container flap, and nothing polls the
    queue in the window before it returns — the user presses Run and waits on a
    worker that is not running."""
    calls = []

    def boom(*_a, **_k):
        calls.append(1)
        if len(calls) >= 3:
            raise KeyboardInterrupt        # the only way out of `while True`
        raise sqlite3.OperationalError("db is locked")

    with mock.patch.object(run_queue, "drain", boom), \
         mock.patch.object(run_queue.time, "sleep", lambda _s: None):
        with pytest.raises(KeyboardInterrupt):
            run_queue.serve("w1", lambda uid, mode: {}, interval=0)

    assert len(calls) == 3, "it must keep polling after a failed drain"
