"""SQLite access to the same dev.db Prisma owns.

Prisma quirks we must honor so the Next.js dashboard can read our rows:
  * DateTime columns are stored as INTEGER epoch-milliseconds.
  * Boolean columns are stored as INTEGER 0/1.
  * id columns are plain TEXT (cuid in the app; any unique string is fine here).
"""
from __future__ import annotations
import os
import sqlite3
import time
import secrets
import json
from contextlib import contextmanager

DB_PATH = os.environ.get(
    "INTERNPILOT_DB",
    os.path.join(os.path.dirname(__file__), "..", "prisma", "dev.db"),
)


def now_ms() -> int:
    return int(time.time() * 1000)


def cuid() -> str:
    # cuid-shaped enough; uniqueness is all that matters for a TEXT pk.
    return "c" + secrets.token_hex(12)


@contextmanager
def conn():
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    try:
        c.execute("PRAGMA busy_timeout = 8000")
        yield c
        c.commit()
    finally:
        c.close()


# ---------- reads ----------

def get_user(uid: str) -> dict | None:
    with conn() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            return None
        p = c.execute("SELECT * FROM profiles WHERE user_id=?", (uid,)).fetchone()
        d = dict(u)
        d["profile"] = dict(p) if p else None
        return d


def active_users() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT id FROM users WHERE paid=1 AND status='active'"
        ).fetchall()
        return [r["id"] for r in rows]


def applied_external_ids(uid: str) -> set[str]:
    """Job urls this user already has an application row for (dedupe)."""
    with conn() as c:
        rows = c.execute(
            "SELECT url FROM applications WHERE user_id=? AND url IS NOT NULL", (uid,)
        ).fetchall()
        return {r["url"] for r in rows}


def todays_applied_count(uid: str) -> int:
    start = _start_of_day_ms()
    with conn() as c:
        r = c.execute(
            "SELECT COUNT(*) n FROM applications "
            "WHERE user_id=? AND status='applied' AND created_at>=?",
            (uid, start),
        ).fetchone()
        return r["n"]


def _start_of_day_ms() -> int:
    t = time.localtime()
    midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    return int(midnight * 1000)


# ---------- writes ----------

def update_skills(uid: str, skills: list[str], plan_json: dict | None = None):
    with conn() as c:
        c.execute(
            "UPDATE profiles SET skills=?, plan_json=?, updated_at=? WHERE user_id=?",
            (
                json.dumps(skills),
                json.dumps(plan_json) if plan_json is not None else None,
                now_ms(),
                uid,
            ),
        )


def set_internshala_connected(uid: str, connected: bool):
    with conn() as c:
        c.execute(
            "UPDATE users SET internshala_connected=? WHERE id=?",
            (1 if connected else 0, uid),
        )


# ---------- multi-platform integrations ----------

def _ensure_integrations_table(c):
    c.execute("""
        CREATE TABLE IF NOT EXISTS user_integrations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'disconnected',
            connected_at INTEGER,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, platform)
        )
    """)


_PLATFORMS = ["linkedin", "internshala", "naukri", "unstop", "indeed"]


def get_integrations(uid: str) -> list[dict]:
    with conn() as c:
        _ensure_integrations_table(c)
        rows = c.execute(
            "SELECT platform, status, connected_at FROM user_integrations WHERE user_id=?",
            (uid,),
        ).fetchall()
    by_p = {r["platform"]: dict(r) for r in rows}
    return [
        by_p.get(p, {"platform": p, "status": "disconnected", "connected_at": None})
        for p in _PLATFORMS
    ]


def get_connected_platforms(uid: str) -> list[str]:
    with conn() as c:
        _ensure_integrations_table(c)
        rows = c.execute(
            "SELECT platform FROM user_integrations WHERE user_id=? AND status='connected'",
            (uid,),
        ).fetchall()
    return [r["platform"] for r in rows]


def set_integration_status(uid: str, platform: str, status: str):
    with conn() as c:
        _ensure_integrations_table(c)
        ts = now_ms()
        existing = c.execute(
            "SELECT id FROM user_integrations WHERE user_id=? AND platform=?",
            (uid, platform),
        ).fetchone()
        connected_at = ts if status == "connected" else None
        if existing:
            c.execute(
                "UPDATE user_integrations SET status=?, connected_at=?, updated_at=? "
                "WHERE user_id=? AND platform=?",
                (status, connected_at, ts, uid, platform),
            )
        else:
            c.execute(
                "INSERT INTO user_integrations "
                "(id, user_id, platform, status, connected_at, updated_at) "
                "VALUES (?,?,?,?,?,?)",
                (cuid(), uid, platform, status, connected_at, ts),
            )
        # keep legacy internshala_connected column in sync
        if platform == "internshala":
            c.execute(
                "UPDATE users SET internshala_connected=? WHERE id=?",
                (1 if status == "connected" else 0, uid),
            )


def get_plan_cap(uid: str) -> int:
    """Daily application cap from user plan (10 = starter, 30 = pro)."""
    with conn() as c:
        u = c.execute("SELECT plan FROM users WHERE id=?", (uid,)).fetchone()
    plan = (u["plan"] if u else None) or "starter"
    return 30 if plan == "pro" else 10


def set_resume_text(uid: str, text: str):
    with conn() as c:
        c.execute(
            "UPDATE profiles SET resume_text=?, updated_at=? WHERE user_id=?",
            (text[:20000], now_ms(), uid),
        )


def upsert_job(job: dict) -> str:
    """job: {source, external_id, title, company, location, stipend, duration, skills(list), url}"""
    with conn() as c:
        existing = c.execute(
            "SELECT id FROM jobs WHERE source=? AND external_id=?",
            (job["source"], job["external_id"]),
        ).fetchone()
        if existing:
            return existing["id"]
        jid = cuid()
        c.execute(
            "INSERT INTO jobs (id, source, external_id, title, company, location, "
            "stipend, duration, skills, url, scraped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                jid,
                job["source"],
                job["external_id"],
                job["title"],
                job["company"],
                job.get("location"),
                job.get("stipend"),
                job.get("duration"),
                json.dumps(job.get("skills", [])),
                job["url"],
                now_ms(),
            ),
        )
        return jid


def add_application(uid: str, *, job_id: str | None, title: str, company: str,
                    url: str | None, score: int, status: str, reason: str,
                    applied: bool):
    with conn() as c:
        c.execute(
            "INSERT INTO applications (id, user_id, job_id, job_title, company, url, "
            "match_score, status, reason, applied_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                cuid(), uid, job_id, title, company, url, int(score), status, reason,
                now_ms() if applied else None, now_ms(),
            ),
        )


def add_report(uid: str, *, date: str, matched: int, applied: int, failed: int,
               summary: str, delivered: bool):
    with conn() as c:
        c.execute(
            "INSERT INTO reports (id, user_id, date, matched_count, applied_count, "
            "failed_count, summary, delivered, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (cuid(), uid, date, matched, applied, failed, summary,
             1 if delivered else 0, now_ms()),
        )
