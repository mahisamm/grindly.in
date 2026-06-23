"""SQLite access to the same dev.db Prisma owns.

Prisma quirks we must honor so the Next.js dashboard can read our rows:
  * DateTime columns are stored as INTEGER epoch-milliseconds.
  * Boolean columns are stored as INTEGER 0/1.
  * id columns are plain TEXT (cuid in the app; any unique string is fine here).
"""
from __future__ import annotations
import os
import sqlite3


def _load_dotenv() -> None:
    """Load project root .env into os.environ (no-op if already set or file missing).
    No external deps — pure stdlib. Must run before any os.environ.get() calls.
    """
    root = os.path.join(os.path.dirname(__file__), "..")
    for name in (".env.local", ".env"):
        path = os.path.normpath(os.path.join(root, name))
        if not os.path.isfile(path):
            continue
        try:
            with open(path, encoding="utf-8", errors="ignore") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, val = line.partition("=")
                    key = key.strip()
                    val = val.strip().strip('"').strip("'")
                    if key and key not in os.environ:
                        os.environ[key] = val
        except Exception as e:
            print(f"[db] dotenv load failed ({path}): {e}")


_load_dotenv()
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

def _ensure_profile_columns(c):
    """Add missing profile columns if Prisma migration hasn't run yet."""
    cols = {row[1] for row in c.execute("PRAGMA table_info(profiles)").fetchall()}
    if "phone" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN phone TEXT")
    if "gpa" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN gpa REAL DEFAULT 8.0")
    if "resume_score" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_score INTEGER")
    if "resume_suggestions" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_suggestions TEXT")
    if "match_quality_rating" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN match_quality_rating INTEGER")
    if "resume_parse_failed" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_parse_failed INTEGER DEFAULT 0")


def get_user(uid: str) -> dict | None:
    with conn() as c:
        _ensure_profile_columns(c)
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
        try:
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
        except sqlite3.IntegrityError:
            # concurrent worker inserted same job between our SELECT and INSERT
            row = c.execute(
                "SELECT id FROM jobs WHERE source=? AND external_id=?",
                (job["source"], job["external_id"]),
            ).fetchone()
            return row["id"] if row else jid
        return jid


def _ensure_app_columns(c):
    """Add columns Prisma may not have migrated yet (resilience if db push skipped)."""
    cols = {row[1] for row in c.execute("PRAGMA table_info(applications)").fetchall()}
    if "failure_reason" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN failure_reason TEXT")
    if "screenshot_path" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN screenshot_path TEXT")
    if "resume_version_id" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN resume_version_id TEXT")
    if "outcome" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN outcome TEXT")
    if "outcome_at" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN outcome_at INTEGER")


def add_application(uid: str, *, job_id: str | None, title: str, company: str,
                    url: str | None, score: int, status: str, reason: str,
                    applied: bool, resume_version_id: str | None = None,
                    failure_reason: str | None = None, screenshot_path: str | None = None):
    with conn() as c:
        _ensure_app_columns(c)
        c.execute(
            "INSERT INTO applications (id, user_id, job_id, job_title, company, url, "
            "match_score, status, reason, failure_reason, screenshot_path, "
            "resume_version_id, applied_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cuid(), uid, job_id, title, company, url, int(score), status, reason,
                failure_reason, screenshot_path, resume_version_id,
                now_ms() if applied else None, now_ms(),
            ),
        )


def _ensure_resume_versions_table(c):
    c.execute("""
        CREATE TABLE IF NOT EXISTS resume_versions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            label TEXT NOT NULL,
            job_title TEXT,
            company TEXT,
            text TEXT NOT NULL,
            file_path TEXT,
            skills_claimed TEXT NOT NULL DEFAULT '[]',
            base_skills TEXT NOT NULL DEFAULT '[]',
            created_at INTEGER NOT NULL
        )
    """)


def add_resume_version(uid: str, *, label: str, job_title: str, company: str,
                       text: str, file_path: str | None,
                       skills_claimed: list[str], base_skills: list[str]) -> str:
    """Immutable snapshot of the exact resume sent. Returns the version id to
    link onto the application row, so the user can later see (and download) the
    precise resume a recruiter received."""
    vid = cuid()
    with conn() as c:
        _ensure_resume_versions_table(c)
        c.execute(
            "INSERT INTO resume_versions (id, user_id, label, job_title, company, "
            "text, file_path, skills_claimed, base_skills, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (vid, uid, label, job_title, company, (text or "")[:40000], file_path,
             json.dumps(skills_claimed), json.dumps(base_skills), now_ms()),
        )
    return vid


def _ensure_audit_table(c):
    c.execute("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id TEXT PRIMARY KEY,
            user_id TEXT,
            action TEXT NOT NULL,
            target TEXT,
            detail TEXT,
            created_at INTEGER NOT NULL
        )
    """)


def add_audit(action: str, *, user_id: str | None = None,
              target: str | None = None, detail: str | None = None):
    with conn() as c:
        _ensure_audit_table(c)
        c.execute(
            "INSERT INTO audit_logs (id, user_id, action, target, detail, created_at) "
            "VALUES (?,?,?,?,?,?)",
            (cuid(), user_id, action, target, detail, now_ms()),
        )


def get_approved_applications(uid: str) -> list[dict]:
    """Return applications with status='approved' for this user, joined with job source."""
    with conn() as c:
        rows = c.execute("""
            SELECT a.id, a.job_title, a.company, a.url, a.match_score,
                   COALESCE(j.source, '') AS source,
                   COALESCE(j.skills, '[]') AS skills,
                   COALESCE(j.external_id, '') AS external_id
            FROM applications a
            LEFT JOIN jobs j ON j.id = a.job_id
            WHERE a.user_id=? AND a.status='approved'
        """, (uid,)).fetchall()
    return [dict(r) for r in rows]


def update_application_status(app_id: str, status: str, reason: str,
                              resume_version_id: str | None = None,
                              failure_reason: str | None = None,
                              screenshot_path: str | None = None):
    with conn() as c:
        _ensure_app_columns(c)
        applied_at = now_ms() if status == "applied" else None
        c.execute(
            "UPDATE applications SET status=?, reason=?, failure_reason=?, "
            "screenshot_path=?, resume_version_id=COALESCE(?, resume_version_id), "
            "applied_at=? WHERE id=?",
            (status, reason, failure_reason, screenshot_path, resume_version_id,
             applied_at, app_id),
        )


def set_resume_analysis(uid: str, score: int, suggestions_json: str):
    """Save resume quality score and full analysis JSON to the user's profile."""
    with conn() as c:
        _ensure_profile_columns(c)
        c.execute(
            "UPDATE profiles SET resume_score=?, resume_suggestions=?, updated_at=? WHERE user_id=?",
            (score, suggestions_json, now_ms(), uid),
        )


def set_resume_parse_failed(uid: str, failed: bool):
    """Flag whether resume parsing yielded no usable skills, so the dashboard can
    prompt the user to fill skills manually instead of silently scoring nothing."""
    with conn() as c:
        _ensure_profile_columns(c)
        c.execute(
            "UPDATE profiles SET resume_parse_failed=?, updated_at=? WHERE user_id=?",
            (1 if failed else 0, now_ms(), uid),
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
