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
import signal
import socket
import threading
import time

import admin_settings
import db

log = logging.getLogger("grindly.queue")

# The job THIS process is executing right now, for the shutdown handler.
# drain() sets it before run_fn and clears it after; a deploy's SIGTERM lands
# between any two bytecodes, so the handler reads whatever is current.
_ACTIVE: dict = {"run_id": None, "worker_id": None}

STALE_LOCK_MS = 30 * 60 * 1000  # a job locked longer than this is presumed crashed
# Absolute wall-clock cap on a single ATTEMPT. The heartbeat renews locked_at every
# ~60s regardless of whether the run is making progress, so a genuinely wedged run
# (e.g. a hung browser close) never trips STALE_LOCK_MS and would block the user's
# queue forever. Enforced by the heartbeat thread itself (_heartbeat_loop), which
# is the only place that knows when THIS attempt started.
#
# It used to be enforced in SQL as `status='running' AND created_at < cutoff`, and
# created_at is the row's birth, not the attempt's. A human-paced run yields with
# reschedule() and is re-claimed minutes later on the same row — so once the row
# was 45 minutes old, every subsequent attempt was force-'failed' the moment
# reclaim_stale next ran, no matter how long it had actually been executing. A
# spread run (5-15 min between platforms, times the daily cap) crosses that line
# by design and could never finish.
MAX_RUN_MS = 45 * 60 * 1000
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
        # The absolute-duration backstop lives in _heartbeat_loop, not here — see
        # MAX_RUN_MS. Once that loop stops renewing, locked_at goes stale and the
        # two statements above reclaim the row, so active_key is still freed
        # without a clause that cannot tell a long run from an old one.


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


def _claim_guarded(c, candidate) -> bool:
    """Safe to claim this candidate right now?

    The candidate query already excludes users with a running job, but under
    concurrent claimers (replicas > 1) that exclusion is a plain read: two
    workers can each pick a *different* queued row for the *same* user (e.g. a
    'live' and an 'analyze' run) and both pass it before either commits —
    double-applying for one user.

    On Postgres we close that with a per-user transaction-scoped advisory lock:
    the first claimer to reach a given user wins the lock, and we then re-read
    'is this user running' *under* the lock. A losing claimer (lock already
    held, or the re-read now shows the user running) skips this candidate and
    tries the next. The lock auto-releases when claim_next's transaction
    commits — which is immediately, since the job itself runs outside it.

    On SQLite this is a no-op: BEGIN IMMEDIATE already serialises every claim
    against a single writer, so the race cannot occur (and there is only ever
    one worker anyway)."""
    if not db.PG:
        return True
    locked = c.execute(
        "SELECT pg_try_advisory_xact_lock(hashtext(?)) AS ok", (candidate["user_id"],)
    ).fetchone()["ok"]
    if not locked:
        return False
    running = c.execute(
        "SELECT 1 FROM agent_runs WHERE user_id=? AND status='running' LIMIT 1",
        (candidate["user_id"],),
    ).fetchone()
    return running is None


# How often the maintenance-mode notice repeats while work is piling up behind
# it. Long enough not to fill the log, short enough that "why is nothing
# running?" is answered by the last few lines rather than by a database query.
_MAINTENANCE_LOG_INTERVAL_SECONDS = 300
_last_maintenance_log = 0.0


def _warn_if_maintenance_is_holding_work() -> None:
    """Say so, loudly and repeatedly, when maintenance mode is why nothing runs.

    Silence here cost a real outage. Maintenance mode was left on, so every
    claim_next() returned None; the worker logged a cheerful "serve loop as ..."
    once and then said nothing for seventeen hours while a user's resume
    analysis and their agent run sat queued and untouched. From the outside the
    product looked broken with no error anywhere — the resume simply never got
    analysed.

    An empty queue under maintenance is genuinely fine and stays quiet. Queued
    work that cannot be claimed is not fine, and now says so.
    """
    global _last_maintenance_log
    now = time.time()
    if now - _last_maintenance_log < _MAINTENANCE_LOG_INTERVAL_SECONDS:
        return
    try:
        with db.conn() as c:
            _ensure_table(c)
            row = c.execute(
                "SELECT count(*) AS n FROM agent_runs WHERE status='queued'"
            ).fetchone()
        waiting = int(dict(row).get("n") or 0) if row else 0
    except Exception:  # noqa: BLE001
        # Never let the warning path be the thing that breaks the loop.
        waiting = -1
    if waiting == 0:
        return
    _last_maintenance_log = now
    log.warning(
        "MAINTENANCE MODE is ON — %s queued job(s) are waiting and will not run "
        "until it is switched off in /admin/settings",
        waiting if waiting >= 0 else "an unknown number of",
    )


# Modes that never touch a job board or send anything anywhere: resume-only
# work. Maintenance mode exists to stop the fleet MUTATING the outside world
# (applies, submissions, scrapes under a user's session) — a resume analysis or
# an optimized-variant build mutates nothing but the user's own rows. The web
# route already promises exactly this ("allowed during maintenance", see
# src/app/api/agent/run/route.ts); before this list the queue silently broke
# that promise: the click succeeded, the row queued, nothing ever claimed it,
# and the card showed "Building…" until the user gave up.
MAINTENANCE_SAFE_MODES = ("analyze", "optimize")


def claim_next(worker_id: str) -> dict | None:
    """Atomically claim the oldest eligible queued job whose user has nothing
    running. Postgres uses row-level locking (FOR UPDATE SKIP LOCKED) plus a
    per-user advisory lock (see _claim_guarded); SQLite uses an immediate
    transaction. Either way two workers never grab the same row, and a user
    with a running job is never double-claimed — so replicas > 1 is safe.
    Jobs still inside their post-failure backoff window are skipped too.

    During maintenance only MAINTENANCE_SAFE_MODES are served; everything that
    can reach a job board stays queued until the switch flips back."""
    maintenance = admin_settings.maintenance_mode()
    if maintenance:
        _warn_if_maintenance_is_holding_work()
    mode_filter = (
        "AND mode IN ({}) ".format(",".join("?" for _ in MAINTENANCE_SAFE_MODES))
        if maintenance else ""
    )
    mode_params = MAINTENANCE_SAFE_MODES if maintenance else ()
    with db.conn() as c:
        _ensure_table(c)
        if db.PG:
            candidates = c.execute(
                "SELECT * FROM agent_runs WHERE status='queued' "
                "AND (available_at IS NULL OR available_at <= CURRENT_TIMESTAMP) "
                "AND attempts < max_attempts "
                f"{mode_filter}"
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY created_at ASC LIMIT 20 FOR UPDATE SKIP LOCKED",
                mode_params,
            ).fetchall()
        else:
            c.execute("BEGIN IMMEDIATE")
            candidates = c.execute(
                "SELECT * FROM agent_runs WHERE status='queued' "
                "AND (available_at IS NULL OR available_at <= ?) "
                "AND attempts < max_attempts "
                f"{mode_filter}"
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY created_at ASC LIMIT 20",
                (db.now_db(), *mode_params),
            ).fetchall()
        row = next(
            (r for r in candidates if _backoff_ok(r) and _claim_guarded(c, r)),
            None,
        )
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
    """Renew this attempt's lease until it finishes, its lease is taken, or it
    runs past MAX_RUN_MS.

    This loop is where the duration cap belongs: it is the only thing that knows
    when THIS attempt began. Stopping renewal lets locked_at go stale, and
    reclaim_stale then requeues or fails the row on its usual terms — so a wedged
    run still gives its active_key back, and a legitimately long one is never cut
    for the sin of being on an old row.

    A DB blip must not end the attempt. This thread is a daemon: an exception
    escaping it kills the lease silently while run_fn carries on working, and the
    row is later reclaimed underneath a run that is still going. Log and retry on
    the next tick instead — a single missed renewal has 30 minutes of
    STALE_LOCK_MS slack behind it."""
    started = time.monotonic()
    while not stop.wait(HEARTBEAT_INTERVAL_SECONDS):
        if (time.monotonic() - started) * 1000 >= MAX_RUN_MS:
            log.error(
                "job %s exceeded the %d-minute cap on one attempt; releasing its lease",
                run_id, MAX_RUN_MS // 60000,
            )
            return
        try:
            if not heartbeat(run_id, worker_id):
                log.error("job %s lease was lost by worker %s", run_id, worker_id)
                return
        except Exception:  # noqa: BLE001
            log.exception("heartbeat for job %s failed; retrying next tick", run_id)


def drain(worker_id: str, run_fn) -> int:
    """Claim + run every available job once. `run_fn(uid, mode) -> dict`.
    Returns number of jobs processed. Per-job failures are caught + retried."""
    try:
        reclaim_stale()
    except Exception:  # noqa: BLE001
        # Housekeeping, not the work itself. A DB blip here used to abort the whole
        # drain and (from serve) exit the process, leaving every 'running' row
        # locked with nothing left alive to release it.
        log.exception("reclaim_stale failed; draining anyway")
    processed = 0
    while True:
        try:
            job = claim_next(worker_id)
        except Exception:  # noqa: BLE001
            log.exception("claim_next failed; ending this drain")
            break
        if not job:
            break
        processed += 1
        _ACTIVE["run_id"], _ACTIVE["worker_id"] = job["id"], worker_id
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
            # Also to the database. A run that dies here is the single most
            # important thing an operator can know about, and until now it lived
            # only in a container log that rotates and that nobody reads until a
            # user complains.
            try:
                import error_log

                error_log.capture(e, context={
                    "job": job["id"], "user": job.get("user_id"),
                    "mode": job.get("mode"), "attempt": job["attempts"],
                })
            except Exception:  # noqa: BLE001
                pass
            try:
                mark_failed(job["id"], worker_id, str(e))
            except Exception:  # noqa: BLE001
                # If this one raises too, the row stays 'running' and its
                # active_key keeps blocking the user's next enqueue until
                # reclaim_stale gets to it. Nothing to do but say so.
                log.exception("could not record the failure of job %s", job["id"])
        finally:
            _ACTIVE["run_id"] = _ACTIVE["worker_id"] = None
            stop_heartbeat.set()
            heartbeat_thread.join(timeout=1)
    return processed


def install_shutdown_handler(worker_id: str) -> None:
    """Hand the in-flight run back to the queue when the container is stopped.

    Every deploy sends SIGTERM. Without this the run kept its lock and the
    user's agent sat idle for the full STALE_LOCK_MS (30 min) before
    reclaim_stale noticed the worker was gone. reschedule(), not mark_failed():
    a deploy is not the run's fault, so it must not spend one of its three
    attempts — and reschedule's attempts-decrement is exactly that contract.

    os._exit, not sys.exit: the run is mid-Playwright in this same thread, and
    unwinding it cleanly inside a 10-second docker-stop grace window is a bet
    we lose — the browser dies with the container either way, and any submit
    already in flight keeps its idempotency claim, so the requeued run skips
    it rather than double-sending.
    """
    def _handoff(signum, frame):  # noqa: ARG001
        rid, wid = _ACTIVE.get("run_id"), _ACTIVE.get("worker_id")
        if rid and wid:
            try:
                if reschedule(rid, wid, delay_seconds=15):
                    log.info("SIGTERM: run %s handed back to the queue", rid)
            except Exception:  # noqa: BLE001
                log.exception("SIGTERM: could not requeue %s; stale reclaim will", rid)
        os._exit(0)

    signal.signal(signal.SIGTERM, _handoff)


def serve(worker_id: str, run_fn, interval: int = 10):
    """Drain in a loop forever (simple service mode)."""
    install_shutdown_handler(worker_id)
    log.info("serve loop as %s, poll %ds", worker_id, interval)
    while True:
        try:
            n = drain(worker_id, run_fn)
        except Exception:  # noqa: BLE001
            # The service loop outlives any one failure. Letting an exception out
            # of here exits the worker process; under Compose's restart policy
            # that is a container flap, and in the window before it comes back
            # nothing polls the queue at all — the user presses Run and waits on a
            # worker that is not there.
            log.exception("drain raised; retrying after the poll interval")
            n = 0
        if n:
            log.info("drained %d job(s)", n)
        time.sleep(interval)
