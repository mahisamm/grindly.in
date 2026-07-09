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
import time

import db

log = logging.getLogger("grindly.queue")

STALE_LOCK_MS = 30 * 60 * 1000  # a job locked longer than this is presumed crashed
BACKOFF_BASE_MS = 2 * 60 * 1000  # linear backoff: 2min * attempts already made


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
            locked_by TEXT,
            locked_at INTEGER,
            error TEXT,
            result TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)


def enqueue(uid: str, mode: str = "live") -> str:
    """Add a run. Idempotent: if the user already has a queued/running job,
    return that one instead of stacking duplicates."""
    with db.conn() as c:
        _ensure_table(c)
        existing = c.execute(
            "SELECT id FROM agent_runs WHERE user_id=? AND status IN ('queued','running') LIMIT 1",
            (uid,),
        ).fetchone()
        if existing:
            return existing["id"]
        rid = db.cuid()
        ts = db.now_db()
        c.execute(
            "INSERT INTO agent_runs (id, user_id, mode, status, attempts, max_attempts, "
            "created_at, updated_at) VALUES (?,?,?,'queued',0,3,?,?)",
            (rid, uid, mode, ts, ts),
        )
        return rid


def reclaim_stale(now_ms: int | None = None):
    """Requeue jobs whose worker died mid-run (lock older than STALE_LOCK_MS)."""
    cutoff = db.time_ago_db(STALE_LOCK_MS)
    with db.conn() as c:
        _ensure_table(c)
        c.execute(
            "UPDATE agent_runs SET status='queued', locked_by=NULL, locked_at=NULL, updated_at=? "
            "WHERE status='running' AND locked_at IS NOT NULL AND locked_at < ?",
            (db.now_db(), cutoff),
        )


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
    with db.conn() as c:
        _ensure_table(c)
        if db.PG:
            candidates = c.execute(
                "SELECT * FROM agent_runs WHERE status='queued' "
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY created_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED"
            ).fetchall()
        else:
            c.execute("BEGIN IMMEDIATE")
            candidates = c.execute(
                "SELECT * FROM agent_runs WHERE status='queued' "
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY created_at ASC LIMIT 20"
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


def mark_done(run_id: str, result: dict):
    with db.conn() as c:
        _ensure_table(c)
        c.execute(
            "UPDATE agent_runs SET status='done', result=?, locked_by=NULL, updated_at=? WHERE id=?",
            (json.dumps(result), db.now_db(), run_id),
        )


def mark_failed(run_id: str, error: str):
    """Requeue with backoff if attempts remain, else mark failed permanently."""
    with db.conn() as c:
        _ensure_table(c)
        row = c.execute(
            "SELECT attempts, max_attempts FROM agent_runs WHERE id=?", (run_id,)
        ).fetchone()
        ts = db.now_db()
        if row and row["attempts"] < row["max_attempts"]:
            c.execute(
                "UPDATE agent_runs SET status='queued', error=?, locked_by=NULL, "
                "locked_at=NULL, updated_at=? WHERE id=?",
                (error[:500], ts, run_id),
            )
        else:
            c.execute(
                "UPDATE agent_runs SET status='failed', error=?, locked_by=NULL, updated_at=? WHERE id=?",
                (error[:500], ts, run_id),
            )


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
        try:
            result = run_fn(job["user_id"], job["mode"])
            mark_done(job["id"], result if isinstance(result, dict) else {"result": str(result)})
        except Exception as e:  # noqa: BLE001
            log.error("job %s failed (attempt %d): %s", job["id"], job["attempts"], e)
            mark_failed(job["id"], str(e))
    return processed


def serve(worker_id: str, run_fn, interval: int = 10):
    """Drain in a loop forever (simple service mode)."""
    log.info("serve loop as %s, poll %ds", worker_id, interval)
    while True:
        n = drain(worker_id, run_fn)
        if n:
            log.info("drained %d job(s)", n)
        time.sleep(interval)
