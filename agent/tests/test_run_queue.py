"""Tests for agent/run_queue.py using an in-memory SQLite DB."""
import sqlite3
import sys
import os
import time
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
    rid = run_queue.enqueue("user_1", mode="mock")
    c = _get_conn()
    row = c.execute("SELECT * FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row is not None
    assert row["status"] == "queued"
    assert row["user_id"] == "user_1"
    assert row["mode"] == "mock"


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
    c.execute("UPDATE agent_runs SET status='done' WHERE id=?", (rid1,))
    c.commit()
    rid2 = run_queue.enqueue("user_1")
    assert rid2 != rid1


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
    run_queue.mark_done(rid, {"applied": 3})
    c = _get_conn()
    row = c.execute("SELECT status, result FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "done"
    import json; assert json.loads(row["result"])["applied"] == 3


def test_mark_failed_requeues_when_attempts_remain():
    rid = run_queue.enqueue("user_1")
    run_queue.claim_next("w1")   # attempts=1, max=3
    run_queue.mark_failed(rid, "transient error")
    c = _get_conn()
    row = c.execute("SELECT status FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "queued"   # requeued for retry


def test_mark_failed_permanently_after_max_attempts():
    rid = run_queue.enqueue("user_1")
    for _ in range(3):
        run_queue.claim_next("w1")
        c = _get_conn()
        # Reset to queued to allow next iteration to re-claim
        c.execute("UPDATE agent_runs SET status='queued' WHERE id=?", (rid,))
        c.commit()
    run_queue.mark_failed(rid, "persistent error")
    c = _get_conn()
    row = c.execute("SELECT status FROM agent_runs WHERE id=?", (rid,)).fetchone()
    assert row["status"] == "failed"


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
