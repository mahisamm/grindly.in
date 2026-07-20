"""DB-backed run queue — retries, per-user locking, crash recovery, idempotent
resume. No Redis needed for the prototype; the agent_runs table IS the queue.

A worker drains it:  python worker.py --drain   (claim all queued, run, exit)
                     python worker.py --serve   (drain in a loop)

claim_next() is transactional (BEGIN IMMEDIATE) and skips users who already have
a running job, so two drain workers never double-apply for the same user.
"""
from __future__ import annotations
import json
import logging
import os
import socket
import threading
import time

import admin_settings
import db

log = logging.getLogger("grindly.queue")

STALE_LOCK_MS = 30 * 60 * 1000  # a job locked longer than this is presumed crashed
BACKOFF_BASE_MS = 2 * 60 * 1000  # linear backoff: 2min * attempts already made
HEARTBEAT_INTERVAL_SECONDS = max(
    1.0, float(os.environ.get("GRINDLY_QUEUE_HEARTBEAT_SECONDS", "60"))
)


def default_worker_id() -> str:
    """Return an identity unique across both processes and containers."""
    host = os.environ.get("HOSTNAME") or socket.gethostname() or "unknown-host"
    return f"w-{host}-{os.getpid()}"


def _ensure_table(c):
    if db.PG:
        return  # schema owned by Prisma migrations on Postgres
    c.execute("""
        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'live',
            status TEXT NOT NULL DEFAULT 'queued',
            attempts INTEGER NOT NULL DEFAULT 0,
            max_attempts INTEGER NOT NULL DEFAULT 3,
            active_key TEXT UNIQUE,
            available_at INTEGER,
            locked_by TEXT,
            locked_at INTEGER,
            error TEXT,
            result TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)
    columns = {row[1] for row in c.execute("PRAGMA table_info(agent_runs)").fetchall()}
    if "active_key" not in columns:
        c.execute("ALTER TABLE agent_runs ADD COLUMN active_key TEXT")
    if "available_at" not in columns:
        c.execute("ALTER TABLE agent_runs ADD COLUMN available_at INTEGER")
    c.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_active_key_key "
        "ON agent_runs(active_key)"
    )


def enqueue(uid: str, mode: str = "live") -> str:
    """Add a run. Idempotent: if the user already has a queued/running job,
    return that one instead of stacking duplicates."""
    with db.conn() as c:
        _ensure_table(c)
        active_key = f"{uid}:{mode}"
        existing = c.execute(
            "SELECT id FROM agent_runs WHERE active_key=? LIMIT 1", (active_key,)
        ).fetchone()
        if existing:
            return existing["id"]
        rid = db.cuid()
        ts = db.now_db()
        c.execute(
            "INSERT INTO agent_runs (id, user_id, mode, status, attempts, max_attempts, "
            "active_key, created_at, updated_at) VALUES (?,?,?,'queued',0,3,?,?,?) "
            "ON CONFLICT(active_key) DO NOTHING",
            (rid, uid, mode, active_key, ts, ts),
        )
        row = c.execute(
            "SELECT id FROM agent_runs WHERE active_key=? LIMIT 1", (active_key,)
        ).fetchone()
        return row["id"] if row else rid


def reclaim_stale(now_ms: int | None = None):
    """Requeue jobs whose worker died mid-run (lock older than STALE_LOCK_MS).

    A job that already used up its retry budget on the attempt that crashed is
    marked failed instead of requeued — otherwise reclaim would hand it an
    extra run beyond max_attempts, since claim_next's own attempts filter only
    guards the *next* claim, not this transition back into 'queued'.
    """
    cutoff = db.time_ago_db(STALE_LOCK_MS)
    ts = db.now_db()
    with db.conn() as c:
        _ensure_table(c)
        c.execute(
            "UPDATE agent_runs SET status='failed', error='stale lock: exceeded max_attempts', "
            "active_key=NULL, locked_by=NULL, locked_at=NULL, updated_at=? "
            "WHERE status='running' AND locked_at IS NOT NULL AND locked_at < ? "
            "AND attempts >= max_attempts",
            (ts, cutoff),
        )
        c.execute(
            "UPDATE agent_runs SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=? "
            "WHERE status='running' AND locked_at IS NOT NULL AND locked_at < ? "
            "AND attempts < max_attempts",
            (ts, cutoff),
        )


def heartbeat(run_id: str, worker_id: str) -> bool:
    """Renew a running job lease. False means this worker no longer owns it."""
    with db.conn() as c:
        _ensure_table(c)
        cursor = c.execute(
            "UPDATE agent_runs SET locked_at=?, updated_at=? "
            "WHERE id=? AND status='running' AND locked_by=?",
            (db.now_db(), db.now_db(), run_id, worker_id),
        )
        return cursor.rowcount == 1


def reschedule(run_id: str, worker_id: str, delay_seconds: float) -> bool:
    """Yield a human-paced job so another user's work can use this worker."""
    available_at = db.time_from_now_db(max(1, int(delay_seconds * 1000)))
    with db.conn() as c:
        _ensure_table(c)
        cursor = c.execute(
            "UPDATE agent_runs SET status='queued', available_at=?, locked_by=NULL, "
            "locked_at=NULL, attempts=CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END, "
            "updated_at=? "
            "WHERE id=? AND status='running' AND locked_by=?",
            (available_at, db.now_db(), run_id, worker_id),
        )
        return cursor.rowcount == 1


def _backoff_ok(row) -> bool:
    """True if a previously-failed job's backoff window has elapsed (or it has
    never been attempted yet). Without this, a job requeued by mark_failed()
    could be reclaimed again within the same drain() loop, milliseconds after
    it failed — the site state hasn't changed that fast, so it's a wasted hit
    that also raises bot-detection risk. Backoff grows linearly with attempts."""
    attempts = row["attempts"] or 0
    if attempts <= 0:
        return True
    updated_at = row["updated_at"]
    if updated_at is None:
        return True
    cutoff = db.time_ago_db(BACKOFF_BASE_MS * attempts)
    return updated_at < cutoff


def claim_next(worker_id: str) -> dict | None:
    """Atomically claim the oldest eligible queued job whose user has nothing
    running. Postgres uses row-level locking (FOR UPDATE SKIP LOCKED); SQLite
    uses an immediate transaction. Either way two workers never grab the same
    row, and a user with a running job is skipped so we never double-apply.
    Jobs still inside their post-failure backoff window are skipped too."""
    if admin_settings.maintenance_mode():
        return None
    with db.conn() as c:
        _ensure_table(c)
        if db.PG:
            candidates = c.execute(
                "SELECT * FROM agent_runs WHERE status='queued' "
                "AND (available_at IS NULL OR available_at <= CURRENT_TIMESTAMP) "
                "AND attempts < max_attempts "
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY created_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED"
            ).fetchall()
        else:
            c.execute("BEGIN IMMEDIATE")
            candidates = c.execute(
                "SELECT * FROM agent_runs WHERE status='queued' "
                "AND (available_at IS NULL OR available_at <= ?) "
                "AND attempts < max_attempts "
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY created_at ASC LIMIT 20",
                (db.now_db(),),
            ).fetchall()
        row = next((r for r in candidates if _backoff_ok(r)), None)
        if not row:
            return None
        ts = db.now_db()
        c.execute(
            "UPDATE agent_runs SET status='running', locked_by=?, locked_at=?, "
            "attempts=attempts+1, updated_at=? WHERE id=?",
            (worker_id, ts, ts, row["id"]),
        )
        d = dict(row)
        d["attempts"] += 1
        d["status"] = "running"
        d["locked_by"] = worker_id
        return d


def mark_done(run_id: str, worker_id: str, result: dict) -> bool:
    with db.conn() as c:
        _ensure_table(c)
        cursor = c.execute(
            "UPDATE agent_runs SET status='done', result=?, active_key=NULL, "
            "locked_by=NULL, locked_at=NULL, updated_at=? "
            "WHERE id=? AND status='running' AND locked_by=?",
            (json.dumps(result), db.now_db(), run_id, worker_id),
        )
        return cursor.rowcount == 1


def mark_failed(run_id: str, worker_id: str, error: str) -> bool:
    """Requeue with backoff if attempts remain, else mark failed permanently."""
    with db.conn() as c:
        _ensure_table(c)
        row = c.execute(
            "SELECT attempts, max_attempts FROM agent_runs "
            "WHERE id=? AND status='running' AND locked_by=?", (run_id, worker_id)
        ).fetchone()
        if not row:
            return False
        ts = db.now_db()
        if row and row["attempts"] < row["max_attempts"]:
            c.execute(
                "UPDATE agent_runs SET status='queued', error=?, locked_by=NULL, "
                "locked_at=NULL, updated_at=? WHERE id=? AND locked_by=?",
                (error[:500], ts, run_id, worker_id),
            )
        else:
            c.execute(
                "UPDATE agent_runs SET status='failed', error=?, active_key=NULL, "
                "locked_by=NULL, locked_at=NULL, updated_at=? WHERE id=? AND locked_by=?",
                (error[:500], ts, run_id, worker_id),
            )
        return True


def _heartbeat_loop(run_id: str, worker_id: str, stop: threading.Event) -> None:
    while not stop.wait(HEARTBEAT_INTERVAL_SECONDS):
        if not heartbeat(run_id, worker_id):
            log.error("job %s lease was lost by worker %s", run_id, worker_id)
            return


def drain(worker_id: str, run_fn) -> int:
    """Claim + run every available job once. `run_fn(uid, mode) -> dict`.
    Returns number of jobs processed. Per-job failures are caught + retried."""
    reclaim_stale()
    processed = 0
    while True:
        job = claim_next(worker_id)
        if not job:
            break
        processed += 1
        stop_heartbeat = threading.Event()
        heartbeat_thread = threading.Thread(
            target=_heartbeat_loop,
            args=(job["id"], worker_id, stop_heartbeat),
            name=f"queue-heartbeat-{job['id']}",
            daemon=True,
        )
        heartbeat_thread.start()
        try:
            result = run_fn(job["user_id"], job["mode"])
            normalized = result if isinstance(result, dict) else {"result": str(result)}
            delay = normalized.pop("_requeue_after_seconds", 0)
            completed = (
                reschedule(job["id"], worker_id, float(delay))
                if delay and float(delay) > 0
                else mark_done(job["id"], worker_id, normalized)
            )
            if not completed:
                log.error("job %s completed after its lease was lost; result discarded", job["id"])
        except Exception as e:  # noqa: BLE001
            log.error("job %s failed (attempt %d): %s", job["id"], job["attempts"], e)
            mark_failed(job["id"], worker_id, str(e))
        finally:
            stop_heartbeat.set()
            heartbeat_thread.join(timeout=1)
    return processed


def serve(worker_id: str, run_fn, interval: int = 10):
    """Drain in a loop forever (simple service mode)."""
    log.info("serve loop as %s, poll %ds", worker_id, interval)
    while True:
        n = drain(worker_id, run_fn)
        if n:
            log.info("drained %d job(s)", n)
        time.sleep(interval)
