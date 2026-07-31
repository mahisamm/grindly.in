"""Database access for the Python agent — works against BOTH backends:

  * SQLite (local/dev/tests)  — the same dev.db Prisma owns. DateTime columns are
    stored as INTEGER epoch-milliseconds, Booleans as INTEGER 0/1, ids as TEXT.
  * PostgreSQL (production)   — selected automatically when DATABASE_URL is a
    postgres URL (and INTERNPILOT_DB is unset). Here Prisma stores DateTime as a
    real `timestamp(3)` and Boolean as `boolean`, so we pass datetimes/bools
    natively. The schema is owned by Prisma migrations — the `_ensure_*` helpers
    are no-ops on Postgres.

Call sites are backend-agnostic: write SQL with `?` placeholders (rewritten to
`%s` on Postgres) and use `now_db()` / `time_ago_db()` / `_start_of_day_db()`
for any DateTime value so the right type is sent to each backend.
"""
from __future__ import annotations
import os


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
import datetime
import sqlite3
from contextlib import contextmanager

DATABASE_URL = os.environ.get("DATABASE_URL", "")
# INTERNPILOT_DB forces the SQLite path (used by tests / local). docker-compose
# sets it to "" for the worker so the Postgres DATABASE_URL takes over.
_SQLITE_OVERRIDE = os.environ.get("INTERNPILOT_DB", "")


def _is_postgres(url: str) -> bool:
    return url.startswith("postgres://") or url.startswith("postgresql://")


PG = _is_postgres(DATABASE_URL) and not _SQLITE_OVERRIDE

if PG:
    import psycopg2
    import psycopg2.extras
    import psycopg2.errors

DB_PATH = _SQLITE_OVERRIDE or os.path.join(
    os.path.dirname(__file__), "..", "prisma", "dev.db"
)


# ---------- time / id helpers ----------

def now_ms() -> int:
    return int(time.time() * 1000)


def _utcnow() -> datetime.datetime:
    # Naive UTC — matches how Prisma stores DateTime in Postgres `timestamp(3)`.
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


def now_db():
    """A value suitable for a Prisma DateTime column on the active backend."""
    return _utcnow() if PG else now_ms()


def time_ago_db(ms: int):
    """`now - ms` as the right type for a DateTime comparison on this backend."""
    return (_utcnow() - datetime.timedelta(milliseconds=ms)) if PG else (now_ms() - ms)


def time_from_now_db(ms: int):
    """`now + ms` as the right type for a DateTime comparison on this backend
    — e.g. an expiry timestamp. now_db() can't just be added to directly:
    it's an int on SQLite but a datetime on Postgres."""
    return (_utcnow() + datetime.timedelta(milliseconds=ms)) if PG else (now_ms() + ms)


def cuid() -> str:
    # cuid-shaped enough; uniqueness is all that matters for a TEXT pk.
    return "c" + secrets.token_hex(12)


def _start_of_day_ms() -> int:
    t = time.localtime()
    midnight = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))
    return int(midnight * 1000)


def _start_of_day_db():
    if PG:
        return _utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return _start_of_day_ms()


# ---------- connection ----------

class _PgConn:
    """Adapts a psycopg2 connection to the sqlite3 `connection.execute(...)` API
    the rest of this module is written against: one reusable dict cursor, and
    `?` placeholders rewritten to `%s`."""

    def __init__(self, raw):
        self._raw = raw
        self._cur = raw.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    def execute(self, sql, params=()):
        self._cur.execute(sql.replace("?", "%s"), params)
        return self._cur

    def cursor(self):
        return self._cur

    def commit(self):
        self._raw.commit()

    def close(self):
        self._raw.close()


def get_conn():
    """A caller-managed DB connection — the caller owns commit() and close().

    Mirrors conn()'s backend setup for code that manages the connection
    lifecycle itself (e.g. agent/email_scanner.py) rather than through the
    `with conn() as c:` context manager. Prefer conn() for new code; this exists
    so the scanner's `c = get_conn(); ...; c.close()` shape has a real backend on
    both Postgres and SQLite. Returns an object exposing the same
    execute()/commit()/close() surface as conn() yields.
    """
    if PG:
        return _PgConn(psycopg2.connect(DATABASE_URL))
    c = sqlite3.connect(DB_PATH, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA busy_timeout = 8000")
    c.execute("PRAGMA journal_mode = WAL")
    return c


@contextmanager
def conn():
    if PG:
        raw = psycopg2.connect(DATABASE_URL)
        try:
            yield _PgConn(raw)
            raw.commit()
        except Exception:
            raw.rollback()
            raise
        finally:
            raw.close()
    else:
        c = sqlite3.connect(DB_PATH, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA busy_timeout = 8000")
            # WAL: let the dashboard (Prisma) keep reading while the worker writes;
            # without it a writer blocks readers and the 4s poll can hit "database is locked".
            c.execute("PRAGMA journal_mode = WAL")
            yield c
            c.commit()
        finally:
            c.close()


# ---------- reads ----------

def _ensure_profile_columns(c):
    """Add missing profile columns if Prisma migration hasn't run yet (SQLite
    only — on Postgres the schema is owned by Prisma migrations)."""
    if PG:
        return
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
    if "auto_apply_consent_at" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN auto_apply_consent_at TEXT")
    if "report_channel" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN report_channel TEXT DEFAULT 'email'")
    if "resume_tex_name" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_tex_name TEXT")
    if "resume_tex_status" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_tex_status TEXT")
    if "resume_tex_detail" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_tex_detail TEXT")
    if "resume_hash" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_hash TEXT")
    if "resume_variant_status" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_variant_status TEXT")
    if "resume_variant_detail" not in cols:
        c.execute("ALTER TABLE profiles ADD COLUMN resume_variant_detail TEXT")
    # Screening-form facts collected in setup (see src/lib/proffQuestions.ts).
    # questions.py answers from these instead of stopping the application.
    for column, ddl in (
        ("grad_year", "INTEGER"), ("grad_month", "INTEGER"),
        ("availability", "TEXT"), ("work_authorization", "TEXT"),
        ("degree", "TEXT"), ("college", "TEXT"),
        ("class10_percent", "REAL"), ("class12_percent", "REAL"),
        ("needs_sponsorship", "TEXT"),
        ("hours_per_week", "INTEGER"), ("willing_to_relocate", "TEXT"),
        ("expected_stipend", "INTEGER"),
        ("linkedin_url", "TEXT"), ("github_url", "TEXT"), ("portfolio_url", "TEXT"),
    ):
        if column not in cols:
            c.execute(f"ALTER TABLE profiles ADD COLUMN {column} {ddl}")


def _ensure_profile_row(c, uid: str):
    """Make sure the user HAS a profile row before we try to update one.

    Every profile write in this module is a bare `UPDATE profiles ... WHERE
    user_id=?`, which affects zero rows and reports success when the row is
    missing. The web only creates it lazily — on resume upload, on a profile
    save, on the OAuth callback — so a user who reaches the agent by any other
    path (or whose row was removed) silently loses every result the worker
    produces: the resume score, the extracted skills, the parse-failed flag, the
    variant status. Nothing errors. The dashboard just keeps showing an
    unanalyzed resume, and the next run pays for the same LLM extraction again
    because resume_hash had nowhere to persist.

    Only id / user_id / updated_at are NOT NULL without a default, so a minimal
    insert is enough; every other column takes its schema default.
    """
    row = c.execute("SELECT 1 FROM profiles WHERE user_id=?", (uid,)).fetchone()
    if row:
        return
    c.execute(
        "INSERT INTO profiles (id, user_id, updated_at) VALUES (?,?,?) "
        "ON CONFLICT (user_id) DO NOTHING",
        (cuid(), uid, now_db()),
    )
    print(f"[db] created the missing profile row for {uid}")


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
            "SELECT id FROM users WHERE status='active'"
        ).fetchall()
        return [r["id"] for r in rows]


# A needs_review row whose failure_reason is set is one the sender stopped at a
# KNOWN obstacle before its point of no return — a human-check on the page, an
# unanswerable required question, a form it could not read. Nothing reached the
# employer, and we know exactly what stopped it.
#
# A needs_review with NO failure_reason is the opposite and far more dangerous
# case: the submit landed and only its confirmation was unreadable
# (safety.classify_submit). That one stays locked forever.
#
# The worker writes the discriminator — see the needs_review branch in
# run_for_user, which passes failure_reason only when record["submit_attempted"]
# is unset. Same signal that decides whether the daily slot and the idempotency
# claim are refunded, so all three answers agree by construction.
_PROVABLY_NOT_SENT = (
    "(status = 'needs_review' AND failure_reason IS NOT NULL"
    # A browser that never launched sent nothing, by definition — the 2026-07-31
    # dead-Xvfb run marked 7 listings 'failed' and burned their URLs and
    # (company, title) pairs forever, though no employer ever saw a byte.
    # Only this reason: other failed rows can be post-click ambiguity (a
    # timeout can fire AFTER the submit landed) and must stay locked.
    # COALESCE, not a bare =: a NULL failure_reason makes the comparison NULL,
    # and `AND NOT <NULL>` silently drops the row from every caller's result.
    " OR (status = 'failed' AND COALESCE(failure_reason, '') = 'browser_launch'))"
)


def repair_misclassified_launch_failures() -> int:
    """One-time, idempotent: rows written before BROWSER_LAUNCH existed.

    The 2026-07-31 dead-Xvfb run classified its launch failures as
    listing_closed ("browser has been **closed**"), so those rows miss the
    _PROVABLY_NOT_SENT unlock above. Keyed on the exact prefix
    channel senders put on a launch error — prose parsing is banned for
    live decisions, but this targets a fixed historical string.
    """
    # substr, not LIKE: the wrapper hands psycopg2 an (empty) params tuple on
    # every execute, so a literal % in the SQL is read as interpolation and
    # raises "tuple index out of range".
    prefix = "could not start a browser"
    with conn() as c:
        cur = c.execute(
            "UPDATE applications SET failure_reason='browser_launch' "
            "WHERE status='failed' "
            f"AND substr(reason, 1, {len(prefix)}) = '{prefix}' "
            "AND (failure_reason IS NULL OR failure_reason <> 'browser_launch')"
        )
        return cur.rowcount or 0


def applied_external_ids(uid: str) -> set[str]:
    """Job urls this user is committed to, and which must never be re-scored.

    Deliberately EXCLUDES 'skipped'. A skip is a scoring judgement, not a
    commitment — it can be wrong (bad threshold, stale resume, a bug in the
    scorer) and it left no trace on the platform. Counting skips here froze
    every listing the first time it was seen: a re-run scored nothing at all and
    reported "matched 0, applied 0", so no scoring fix could ever reach a job the
    agent had already dismissed once.

    Also excludes a needs_review that provably never sent anything. Those were
    locked for the same wrong reason skips once were: an ATS page showing a
    human-check on a Tuesday from one IP is a fact about that moment, not about
    the listing — but it burned the URL permanently, so the fix that would have
    got through (running the browser headed, a retry from the user's own
    browser) could never reach it. Over time that is most employer listings.

    Everything else stays locked — applied / approved / matched / failed, and an
    AMBIGUOUS needs_review, have all either reached the employer or are awaiting
    a human decision.
    """
    with conn() as c:
        rows = c.execute(
            "SELECT url FROM applications "
            "WHERE user_id=? AND url IS NOT NULL AND status <> 'skipped' "
            f"AND NOT {_PROVABLY_NOT_SENT}",
            (uid,),
        ).fetchall()
        return {r["url"] for r in rows}


# Hosts worth remembering a company slug from. Kept as a plain list because it
# is spliced into SQL below — every entry is a literal written here, never user
# input. Mirrors agent/hosts.py's ATS vendor list; a host added there and
# forgotten here costs only learning speed, not correctness.
_ATS_URL_MARKERS = (
    "greenhouse.io", "lever.co", "ashbyhq.com", "smartrecruiters.com",
    "myworkdayjobs.com", "workable.com", "recruitee.com", "darwinbox.in",
    "darwinbox.com", "keka.com", "zohorecruit.com", "zohorecruit.in",
    "freshteam.com", "teamtailor.com",
)


def known_ats_urls(limit: int = 2000) -> list[str]:
    """Every ATS posting URL the system has ever seen, for any user.

    `atsboards` reads company slugs back out of these. Discovery that only ever
    looks at a hardcoded list of boards cannot learn, and the boards worth
    asking are exactly the ones something already found — so a company a web
    search surfaced once on a good day gets queried directly from then on.

    Reads `jobs`, NOT `applications`. It used to read applications, which made
    the whole learning loop conditional on somebody having APPLIED to a company
    before it was worth asking that company for openings — so a fresh install
    (zero applications) could never learn a single board, and clearing one
    account's history froze the board list at whatever was hardcoded. Measured
    live: exactly the 58 hardcoded boards, no matter how many ATS postings
    discovery had already found. `jobs` holds every listing ever discovered, is
    global rather than per-user, and survives a user reset.

    Fleet-wide on purpose and safe to be: a board's public postings are the same
    for everyone, and nothing here reads a user's own rows — only which
    employers exist.
    """
    like = " OR ".join(f"url LIKE '%{marker}%'" for marker in _ATS_URL_MARKERS)
    with conn() as c:
        rows = c.execute(
            "SELECT DISTINCT url FROM jobs "
            f"WHERE url IS NOT NULL AND ({like}) "
            "ORDER BY scraped_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
        urls = [r["url"] for r in rows if r["url"]]
        # Applications stay a secondary source: a listing can be applied to via a
        # route that never created a job row (the Apply Kit, the extension), and
        # that employer is still worth asking directly.
        rows = c.execute(
            "SELECT DISTINCT url FROM applications "
            f"WHERE url IS NOT NULL AND ({like}) LIMIT ?",
            (int(limit),),
        ).fetchall()
        seen = set(urls)
        urls.extend(r["url"] for r in rows if r["url"] and r["url"] not in seen)
        return urls


def committed_role_keys(uid: str) -> set[tuple[str, str]]:
    """(company, title-prefix) pairs this user is already committed to.

    `applied_external_ids` above dedups by URL, which only catches the SAME
    posting seen twice. The same role cross-posted to two boards has two
    different URLs, so the worker also dedups on (company, title) — but it kept
    that set in memory, rebuilt empty on every invocation. Across runs, and
    across the segments a spread-mode run is split into, the identical role
    therefore got applied to more than once, under the candidate's real name, at
    the same employer.

    Same status rule as `applied_external_ids`, and for the same reason: a
    'skipped' row is a scoring judgement that left no trace on the platform and
    must stay re-considerable.
    """
    with conn() as c:
        # job_title, not title — the column is `job_title` on this table, and
        # getting it wrong here raised inside run_for_user and failed the entire
        # live run, not just this lookup.
        rows = c.execute(
            "SELECT company, job_title FROM applications "
            "WHERE user_id=? AND status <> 'skipped' "
            # Same exclusion as applied_external_ids, or it is meaningless
            # there: a provably-unsent row re-admitted by URL was still
            # skipped here as "duplicate: applied to same role".
            f"AND NOT {_PROVABLY_NOT_SENT}",
            (uid,),
        ).fetchall()
        return {
            ((r["company"] or "").lower(), (r["job_title"] or "").lower()[:40])
            for r in rows
            if r["company"] or r["job_title"]
        }


def clear_skipped(uid: str, urls: list[str]) -> int:
    """Drop stale rows for listings we are about to re-score, so a re-run
    replaces the old verdict rather than filing a duplicate row beside it.

    Covers exactly the two verdicts applied_external_ids lets back through:
    'skipped' (a scoring judgement that may have been wrong) and a needs_review
    that provably never sent anything (a known obstacle at a moment in time).
    Deleting the old row is what keeps the retry a REPLACEMENT — without it the
    user would collect a second row for the same listing every sweep.

    Returns the number of rows removed.
    """
    urls = [u for u in urls if u]
    if not urls:
        return 0
    removed = 0
    with conn() as c:
        # Chunked so a large fetch can't exceed the driver's parameter limit.
        for i in range(0, len(urls), 200):
            chunk = urls[i:i + 200]
            marks = ",".join("?" for _ in chunk)
            cur = c.execute(
                f"DELETE FROM applications WHERE user_id=? "
                f"AND (status='skipped' OR {_PROVABLY_NOT_SENT}) "
                f"AND url IN ({marks})",
                (uid, *chunk),
            )
            removed += cur.rowcount or 0
    return removed


def todays_applied_count(uid: str) -> int:
    """How much of today's cap this user has actually spent.

    Counts an AMBIGUOUS 'needs_review' as well as 'applied', because it also
    cost a real submission: the submit landed and only the CONFIRMATION was
    unreadable (see safety.classify_submit). Counting 'applied' alone made the
    cap refundable — the worker decrements its in-memory `remaining` for an
    ambiguous submit, but a spread-mode run yields and requeues, and the next
    segment recomputes remaining as `cap - todays_applied_count`, restoring
    every ambiguous one. A channel returning needs_review repeatedly could then
    submit well past the number of applications the user agreed to send today.

    A needs_review that provably never sent (failure_reason set — a human-check
    on the page, an unanswerable required question) is NOT counted, for the same
    reason 'failed' is not: it did not reach the employer. Charging the user's
    daily allowance for an application no employer received is the same lie the
    reservation ledger was fixed to stop telling, one layer up.
    """
    start = _start_of_day_db()
    with conn() as c:
        r = c.execute(
            "SELECT COUNT(*) n FROM applications "
            "WHERE user_id=? AND status IN ('applied','needs_review') "
            f"AND NOT {_PROVABLY_NOT_SENT} AND created_at>=?",
            (uid, start),
        ).fetchone()
        return r["n"]


def total_applied_count(uid: str) -> int:
    """Lifetime successful applications (stat/reporting only; quota is per-day now)."""
    with conn() as c:
        r = c.execute(
            "SELECT COUNT(*) n FROM applications WHERE user_id=? AND status='applied'",
            (uid,),
        ).fetchone()
        return r["n"]


# ---------- writes ----------

def update_skills(uid: str, skills: list[str], plan_json: dict | None = None):
    with conn() as c:
        _ensure_profile_row(c, uid)
        c.execute(
            "UPDATE profiles SET skills=?, plan_json=?, updated_at=? WHERE user_id=?",
            (
                json.dumps(skills),
                json.dumps(plan_json) if plan_json is not None else None,
                now_db(),
                uid,
            ),
        )


def update_contact(uid: str, phone: str | None = None, gpa: float | None = None,
                   **extra) -> dict:
    """Prefill BLANK form-fill fields from resume extraction — never overwrites a
    value the user set. Phone fills only when currently empty; GPA fills only when
    it's null or still the 8.0 default (a placeholder nobody chose). Returns the
    dict of fields actually filled, for logging.

    `extra` carries the rest of what resume_ai.extract_contact reads off the page
    (degree, college, grad_year, linkedin_url, github_url). Same rule: a column
    that already holds something the user can see is left alone. The point is
    that setup arrives pre-filled and the user confirms rather than types — a
    field the resume states is a field nobody should be asked for twice.
    """
    text_columns = ("degree", "college", "linkedin_url", "github_url", "portfolio_url")
    num_columns = ("grad_year",)
    # Percentages are decimals (94.5 is a real board result), so they cannot ride
    # along with grad_year's int() cast.
    decimal_columns = ("class12_percent", "class10_percent")
    filled: dict = {}
    # The candidate's name lives on `users`, not `profiles` — and it is the one
    # field setup used to demand by hand from every user whose Google account had
    # no name on it, while their own resume stated it in the first line.
    name = str(extra.get("name") or "").strip()
    if name:
        with conn() as c:
            row = c.execute("SELECT name FROM users WHERE id=?", (uid,)).fetchone()
            if row is not None and not str(row["name"] or "").strip():
                c.execute("UPDATE users SET name=? WHERE id=?", (name[:200], uid))
                filled["name"] = name
    with conn() as c:
        _ensure_profile_columns(c)
        _ensure_profile_row(c, uid)
        columns = ["phone", "gpa", *text_columns, *num_columns, *decimal_columns]
        row = c.execute(
            f"SELECT {', '.join(columns)} FROM profiles WHERE user_id=?", (uid,)
        ).fetchone()
        if not row:
            return filled
        cur_phone = row["phone"]
        cur_gpa = row["gpa"]
        sets: list[str] = []
        vals: list = []
        if phone and not (str(cur_phone or "").strip()):
            sets.append("phone=?")
            vals.append(phone)
            filled["phone"] = phone
        if gpa is not None and (cur_gpa is None or abs(float(cur_gpa) - 8.0) < 1e-9):
            sets.append("gpa=?")
            vals.append(float(gpa))
            filled["gpa"] = gpa
        for column in text_columns:
            value = str(extra.get(column) or "").strip()
            if value and not str(row[column] or "").strip():
                sets.append(f"{column}=?")
                vals.append(value[:200])
                filled[column] = value
        for column in num_columns:
            value = extra.get(column)
            if value and not row[column]:
                sets.append(f"{column}=?")
                vals.append(int(value))
                filled[column] = value
        for column in decimal_columns:
            value = extra.get(column)
            # `not row[column]` is the right emptiness test here as well as
            # elsewhere: 0 is the unset marker for these, and nobody scored 0%.
            if value and not row[column]:
                sets.append(f"{column}=?")
                vals.append(float(value))
                filled[column] = value
        if sets:
            vals.append(now_db())
            vals.append(uid)
            c.execute(f"UPDATE profiles SET {', '.join(sets)}, updated_at=? WHERE user_id=?", vals)
    return filled


def set_internshala_connected(uid: str, connected: bool):
    with conn() as c:
        c.execute(
            "UPDATE users SET internshala_connected=? WHERE id=?",
            (bool(connected), uid),
        )


# ---------- multi-platform integrations ----------

def _ensure_integrations_table(c):
    if PG:
        return
    c.execute("""
        CREATE TABLE IF NOT EXISTS user_integrations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'disconnected',
            connected_at INTEGER,
            otp_required INTEGER DEFAULT 0,
            otp_code TEXT,
            last_error TEXT,
            connect_token TEXT,
            connect_token_expires_at INTEGER,
            connect_claimed_by TEXT,
            connect_claimed_at INTEGER,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, platform)
        )
    """)
    # Older SQLite DBs predate one feature or the other — add columns in place.
    cols = {row[1] for row in c.execute("PRAGMA table_info(user_integrations)").fetchall()}
    if "otp_required" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN otp_required INTEGER DEFAULT 0")
    if "otp_code" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN otp_code TEXT")
    if "last_error" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN last_error TEXT")
    if "connect_token" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN connect_token TEXT")
    if "connect_token_expires_at" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN connect_token_expires_at INTEGER")
    if "connect_claimed_by" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN connect_claimed_by TEXT")
    if "connect_claimed_at" not in cols:
        c.execute("ALTER TABLE user_integrations ADD COLUMN connect_claimed_at INTEGER")


def _ensure_credentials_table(c):
    if PG:
        return
    c.execute("""
        CREATE TABLE IF NOT EXISTS platform_credentials (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            platform TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(user_id, platform)
        )
    """)


def _ensure_company_reputation_table(c):
    """Scam-gate Layer 2 cache (SQLite only — Prisma owns the Postgres schema via
    db push; see the CompanyReputation model). Columns mirror that model."""
    if PG:
        return
    c.execute("""
        CREATE TABLE IF NOT EXISTS company_reputation (
            id TEXT PRIMARY KEY,
            company TEXT NOT NULL UNIQUE,
            verdict TEXT NOT NULL DEFAULT 'ok',
            confidence REAL NOT NULL DEFAULT 0,
            evidence TEXT,
            source TEXT NOT NULL DEFAULT 'llm',
            checked_at INTEGER NOT NULL
        )
    """)


def get_company_reputation(company: str, max_age_ms: int | None = None) -> dict | None:
    """Cached reputation row for a NORMALIZED company name (see
    company_rep.normalize), or None if there's no row — or it's older than
    max_age_ms. checked_at is epoch-ms on SQLite and a timestamp on Postgres, so
    the freshness bound is expressed via time_ago_db() to match each backend."""
    if not company:
        return None
    with conn() as c:
        _ensure_company_reputation_table(c)
        if max_age_ms is not None:
            row = c.execute(
                "SELECT verdict, confidence, evidence, source FROM company_reputation "
                "WHERE company=? AND checked_at >= ?",
                (company, time_ago_db(max_age_ms)),
            ).fetchone()
        else:
            row = c.execute(
                "SELECT verdict, confidence, evidence, source FROM company_reputation "
                "WHERE company=?",
                (company,),
            ).fetchone()
        return dict(row) if row else None


def set_company_reputation(company: str, verdict: str, confidence: float,
                           evidence: str | None = None, source: str = "llm") -> None:
    """Upsert a reputation verdict for a normalized company name."""
    if not company:
        return
    with conn() as c:
        _ensure_company_reputation_table(c)
        c.execute(
            "INSERT INTO company_reputation "
            "(id, company, verdict, confidence, evidence, source, checked_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(company) DO UPDATE SET "
            "verdict=excluded.verdict, confidence=excluded.confidence, "
            "evidence=excluded.evidence, source=excluded.source, "
            "checked_at=excluded.checked_at",
            (cuid(), company, verdict, float(confidence), evidence, source, now_db()),
        )


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


def get_integration(uid: str, platform: str) -> dict | None:
    with conn() as c:
        _ensure_integrations_table(c)
        row = c.execute(
            "SELECT platform, status, connected_at, updated_at FROM user_integrations "
            "WHERE user_id=? AND platform=?",
            (uid, platform),
        ).fetchone()
    return dict(row) if row else None


def set_integration_status(uid: str, platform: str, status: str, error: str | None = None):
    """Set the connection status. Always clears the OTP-required flag (a status
    transition resolves any pending OTP wait); pass `error` to surface a failure
    reason to the dashboard, or None to clear it."""
    with conn() as c:
        _ensure_integrations_table(c)
        ts = now_db()
        existing = c.execute(
            "SELECT id FROM user_integrations WHERE user_id=? AND platform=?",
            (uid, platform),
        ).fetchone()
        connected_at = ts if status == "connected" else None
        err = (error or "")[:300] if error else None
        if existing:
            c.execute(
                "UPDATE user_integrations SET status=?, connected_at=?, "
                "otp_required=?, otp_code=NULL, last_error=?, connect_claimed_by=NULL, "
                "connect_claimed_at=NULL, updated_at=? "
                "WHERE user_id=? AND platform=?",
                (status, connected_at, False, err, ts, uid, platform),
            )
        else:
            c.execute(
                "INSERT INTO user_integrations "
                "(id, user_id, platform, status, connected_at, otp_required, "
                "otp_code, last_error, updated_at) "
                "VALUES (?,?,?,?,?,?,NULL,?,?)",
                (cuid(), uid, platform, status, connected_at, False, err, ts),
            )
        # keep legacy internshala_connected column in sync
        if platform == "internshala":
            c.execute(
                "UPDATE users SET internshala_connected=? WHERE id=?",
                (status == "connected", uid),
            )


def set_integration_otp_required(uid: str, platform: str):
    """Mark that the login hit an OTP gate — the worker now polls for the code the
    user posts from the dashboard. Clears any stale code first."""
    with conn() as c:
        _ensure_integrations_table(c)
        ts = now_db()
        c.execute(
            "UPDATE user_integrations SET status='otp_required', otp_required=?, "
            "otp_code=NULL, last_error=NULL, updated_at=? WHERE user_id=? AND platform=?",
            (True, ts, uid, platform),
        )


def take_integration_otp(uid: str, platform: str) -> str | None:
    """Atomically read-and-clear the OTP code the user submitted, if any."""
    with conn() as c:
        _ensure_integrations_table(c)
        row = c.execute(
            "SELECT otp_code FROM user_integrations WHERE user_id=? AND platform=?",
            (uid, platform),
        ).fetchone()
        code = row["otp_code"] if row else None
        if code:
            c.execute(
                "UPDATE user_integrations SET otp_code=NULL, updated_at=? "
                "WHERE user_id=? AND platform=?",
                (now_db(), uid, platform),
            )
        return code


def get_platform_credential(uid: str, platform: str) -> str | None:
    """Return the encrypted credential blob (ciphertext) for a platform, or None."""
    with conn() as c:
        _ensure_credentials_table(c)
        row = c.execute(
            "SELECT ciphertext FROM platform_credentials WHERE user_id=? AND platform=?",
            (uid, platform),
        ).fetchone()
        return row["ciphertext"] if row else None


def next_pending_connect_request(worker_id: str = "connect-service") -> dict | None:
    """Atomically claim the oldest pending or abandoned connect request.

    Skips (does not claim) a user with an apply run currently `running` in the
    agent_runs queue. Without this, connect_service ran on its own 3s poll,
    entirely independent of run_queue.claim_next()'s per-user exclusion, so a
    user mid-apply-run could have a *second* Chromium launched against the
    identical persistent-profile directory — and stealth.clear_stale_lock()
    unconditionally deletes the first (live) process's singleton lock rather
    than protecting it, risking a crash/corruption in both. The row stays
    'connecting' and is picked up on a later tick once the run finishes.
    """
    import run_queue  # local import: run_queue already imports db, avoid a cycle

    stale_before = time_ago_db(10 * 60 * 1000)
    with conn() as c:
        _ensure_integrations_table(c)
        run_queue._ensure_table(c)
        if PG:
            row = c.execute(
                "SELECT user_id, platform FROM user_integrations "
                "WHERE status='connecting' "
                "AND (connect_claimed_at IS NULL OR connect_claimed_at < ?) "
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY updated_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
                (stale_before,),
            ).fetchone()
        else:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute(
                "SELECT user_id, platform FROM user_integrations "
                "WHERE status='connecting' "
                "AND (connect_claimed_at IS NULL OR connect_claimed_at < ?) "
                "AND user_id NOT IN (SELECT user_id FROM agent_runs WHERE status='running') "
                "ORDER BY updated_at ASC LIMIT 1",
                (stale_before,),
            ).fetchone()
        if not row:
            return None
        c.execute(
            "UPDATE user_integrations SET connect_claimed_by=?, connect_claimed_at=? "
            "WHERE user_id=? AND platform=?",
            (worker_id, now_db(), row["user_id"], row["platform"]),
        )
        return dict(row)


def release_connect_request(uid: str, platform: str, worker_id: str) -> None:
    with conn() as c:
        _ensure_integrations_table(c)
        c.execute(
            "UPDATE user_integrations SET connect_claimed_by=NULL, connect_claimed_at=NULL "
            "WHERE user_id=? AND platform=? AND connect_claimed_by=?",
            (uid, platform, worker_id),
        )


def set_connect_token(uid: str, platform: str, token: str, expires_at_ms: int):
    """Token gating the remote-browser viewer — see connect_service.py.
    Never log this value; it's the only thing standing between anyone with
    the URL and a live, mid-login browser session."""
    with conn() as c:
        _ensure_integrations_table(c)
        c.execute(
            "UPDATE user_integrations SET connect_token=?, connect_token_expires_at=? "
            "WHERE user_id=? AND platform=?",
            (token, expires_at_ms, uid, platform),
        )


def clear_connect_token(uid: str, platform: str):
    with conn() as c:
        _ensure_integrations_table(c)
        c.execute(
            "UPDATE user_integrations SET connect_token=NULL, connect_token_expires_at=NULL "
            "WHERE user_id=? AND platform=?",
            (uid, platform),
        )


# Daily application cap per plan. Mirrors src/lib/plans.ts — keep the two in sync.
PLAN_CAPS = {"free": 5, "plus": 5, "pro": 15}
# "starter" was the old name for "plus" and is still on live rows. Every read
# normalises through here rather than comparing the raw column, so a legacy row
# keeps working without a data migration.
_PLAN_ALIASES = {"starter": "plus"}


def normalize_plan(plan: str | None) -> str:
    p = (plan or "free").strip().lower()
    p = _PLAN_ALIASES.get(p, p)
    return p if p in PLAN_CAPS else "free"


def get_plan_cap(uid: str) -> int:
    """Daily application allowance (free=5/day, plus=5/day, pro=15/day)."""
    with conn() as c:
        u = c.execute("SELECT plan FROM users WHERE id=?", (uid,)).fetchone()
    return PLAN_CAPS[normalize_plan(u["plan"] if u else None)]


def get_user_plan(uid: str) -> str:
    with conn() as c:
        u = c.execute("SELECT plan FROM users WHERE id=?", (uid,)).fetchone()
    return normalize_plan(u["plan"] if u else None)


def set_resume_text(uid: str, text: str):
    with conn() as c:
        _ensure_profile_row(c, uid)
        c.execute(
            "UPDATE profiles SET resume_text=?, updated_at=? WHERE user_id=?",
            (text[:20000], now_db(), uid),
        )


def upsert_job(job: dict) -> str:
    """job: {source, external_id, title, company, location, stipend, duration, skills(list), url}"""
    with conn() as c:
        if PG:
            # Single round-trip, race-safe: insert-or-ignore then read back the id.
            c.execute(
                "INSERT INTO jobs (id, source, external_id, title, company, location, "
                "stipend, duration, skills, url, scraped_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) "
                "ON CONFLICT (source, external_id) DO NOTHING",
                (
                    cuid(), job["source"], job["external_id"], job["title"], job["company"],
                    job.get("location"), job.get("stipend"), job.get("duration"),
                    json.dumps(job.get("skills", [])), job["url"], now_db(),
                ),
            )
            row = c.execute(
                "SELECT id FROM jobs WHERE source=? AND external_id=?",
                (job["source"], job["external_id"]),
            ).fetchone()
            return row["id"]

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
                    now_db(),
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


# Postgres columns this module writes that a lagging `prisma db push` may not
# have created yet. Checked once per process (see _ensure_app_columns): the
# alternative is that every single application insert fails until the migrate
# step lands, which turns a deploy-ordering slip into a fleet-wide outage.
_PG_APP_COLUMNS = (
    ("apply_channel", "TEXT"),
    ("apply_tier", "TEXT"),
    ("apply_target", "TEXT"),
    ("blocking_facts", "TEXT"),
)
_pg_app_columns_checked = False


def _ensure_app_columns(c):
    """Add columns Prisma may not have migrated yet.

    On SQLite this is the long-standing local-dev resilience path. On Postgres
    it runs once per process and only for the columns the agent writes ahead of
    a schema push — ADD COLUMN IF NOT EXISTS is idempotent and cheap, and it
    removes the ordering dependency between the migrate step and the workers.
    """
    global _pg_app_columns_checked
    if PG:
        if _pg_app_columns_checked:
            return
        # Read the catalogue first, so the common path (columns already pushed by
        # prisma) issues ZERO DDL. ALTER TABLE takes an ACCESS EXCLUSIVE lock on
        # a live table even when IF NOT EXISTS makes it a no-op, and every worker
        # process would otherwise grab it on its first write.
        try:
            existing = {
                r["column_name"]
                for r in c.execute(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_name = 'applications'"
                ).fetchall()
            }
        except Exception as e:  # noqa: BLE001
            print(f"[db] could not read applications columns: {e}")
            _pg_app_columns_checked = True
            return

        for name, coltype in _PG_APP_COLUMNS:
            if name in existing:
                continue
            # SAVEPOINT is load-bearing. conn() runs a real transaction, so a
            # failed statement puts Postgres in an aborted state and EVERY later
            # query on that connection raises InFailedSqlTransaction — including
            # the INSERT this helper was called to make safe. Swallowing the
            # ALTER error without unwinding to a savepoint turned "could not add
            # a column" into "this worker cannot write applications at all".
            try:
                c.execute("SAVEPOINT ensure_app_col")
                c.execute(f"ALTER TABLE applications ADD COLUMN {name} {coltype}")
                c.execute("RELEASE SAVEPOINT ensure_app_col")
            except Exception as e:  # noqa: BLE001
                # A read-only role or a concurrent prisma push can lose this
                # race; the column exists either way once the push completes.
                print(f"[db] could not ensure applications.{name}: {e}")
                try:
                    c.execute("ROLLBACK TO SAVEPOINT ensure_app_col")
                    c.execute("RELEASE SAVEPOINT ensure_app_col")
                except Exception:  # noqa: BLE001
                    pass
        _pg_app_columns_checked = True
        return
    cols = {row[1] for row in c.execute("PRAGMA table_info(applications)").fetchall()}
    if "failure_reason" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN failure_reason TEXT")
    if "screenshot_path" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN screenshot_path TEXT")
    if "resume_version_id" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN resume_version_id TEXT")
    if "blocking_facts" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN blocking_facts TEXT")
    if "outcome" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN outcome TEXT")
    if "outcome_at" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN outcome_at INTEGER")
    if "scheduled_for" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN scheduled_for INTEGER")
    if "notified_at" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN notified_at INTEGER")
    if "answers_json" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN answers_json TEXT")
    if "missing_skills" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN missing_skills TEXT")
    if "cover_letter" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN cover_letter TEXT")
    # Resolved application destination — see agent/resolver.py and the
    # Application model in prisma/schema.prisma for what these mean.
    if "apply_channel" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN apply_channel TEXT")
    if "apply_tier" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN apply_tier TEXT")
    if "apply_target" not in cols:
        c.execute("ALTER TABLE applications ADD COLUMN apply_target TEXT")


def add_application(uid: str, *, job_id: str | None, title: str, company: str,
                    url: str | None, score: int, status: str, reason: str,
                    applied: bool, resume_version_id: str | None = None,
                    failure_reason: str | None = None, screenshot_path: str | None = None,
                    scheduled_for=None, answers_json: str | None = None,
                    missing_skills: list[str] | None = None,
                    destination: dict | None = None,
                    blocking_facts: list[str] | None = None):
    """Record one application row.

    `destination` is the resolver's verdict for this listing (channel/tier/
    target). Passing it is what makes Tier A coverage measurable — every row
    carries where it was, or would have been, delivered.
    """
    dest = destination or {}
    with conn() as c:
        _ensure_app_columns(c)
        c.execute(
            "INSERT INTO applications (id, user_id, job_id, job_title, company, url, "
            "match_score, status, reason, failure_reason, screenshot_path, "
            "resume_version_id, scheduled_for, answers_json, missing_skills, "
            "apply_channel, apply_tier, apply_target, blocking_facts, "
            "applied_at, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                cuid(), uid, job_id, title, company, url, int(score), status, reason,
                failure_reason, screenshot_path, resume_version_id, scheduled_for,
                answers_json, json.dumps(missing_skills) if missing_skills else None,
                dest.get("channel"), dest.get("tier"), dest.get("target"),
                json.dumps(blocking_facts) if blocking_facts else None,
                now_db() if applied else None, now_db(),
            ),
        )


def destination_coverage(uid: str | None = None, since_ms: int | None = None) -> list[dict]:
    """Applications grouped by (channel, tier) — the shadow-mode readout.

    This is the number the whole routing effort turns on: what share of real
    discovered listings resolve to a destination we may submit unattended. It is
    deliberately a query rather than a counter so a week of existing rows can be
    read back without having planned for it.
    """
    where, params = ["apply_channel IS NOT NULL"], []
    if uid:
        where.append("user_id=?")
        params.append(uid)
    if since_ms:
        where.append("created_at >= ?")
        params.append(time_ago_db(since_ms))
    with conn() as c:
        _ensure_app_columns(c)
        rows = c.execute(
            "SELECT apply_channel AS channel, apply_tier AS tier, COUNT(*) AS n "
            f"FROM applications WHERE {' AND '.join(where)} "
            "GROUP BY apply_channel, apply_tier ORDER BY n DESC",
            tuple(params),
        ).fetchall()
    return [
        {"channel": r["channel"], "tier": r["tier"], "count": int(r["n"])}
        for r in rows
    ]


def pipeline_depth(uid: str, deliverable_only: bool = False) -> int:
    """Every match banked for this user — today's and every future day's.

    Discovery fills a month of work in one sweep, so a run should not re-scrape
    the boards when there is already a queue — that is just extra traffic to a
    site that is watching for exactly that.

    `deliverable_only` narrows it to work the AGENT can still finish, which is
    the only question worth asking in no-touch mode. This is not a refinement;
    it is the difference between a working agent and a dead one.

    A queue of rows nobody will ever send still counts as a queue, so discovery
    is suppressed for being "stocked" — and in no-touch mode discovery is the
    only thing that sends, because a match it can deliver is dispatched inline
    the moment it is found and never banked. One account reached 43 banked
    rows — 25 behind a dead Internshala session, 17 on boards that are never
    submitted server-side — sat permanently above the refill threshold, and
    therefore searched nothing and sent nothing, every day, while every switch
    in the system read "on".

    Two exclusions, both about whether the row can still move:
      * tier C is never submitted from our servers at any setting;
      * a row carrying a failure_reason has already come back from an attempt —
        it is a blockage, not a backlog.
    """
    sql = "SELECT COUNT(*) AS n FROM applications WHERE user_id=? AND status='matched'"
    if deliverable_only:
        sql += (
            " AND COALESCE(apply_tier, '') <> 'C'"
            " AND failure_reason IS NULL"
        )
    with conn() as c:
        _ensure_app_columns(c)
        row = c.execute(sql, (uid,)).fetchone()
    return int(row["n"] if row else 0)


def has_live_run_today(uid: str) -> bool:
    """True if a full sweep is already queued, running, or DONE for this user
    today. Guards the daily sweep against re-enqueueing on a container restart.

    'failed' is excluded on purpose. Counting it meant a run that died — a stale
    lease reclaimed by run_queue.reclaim_stale, three exhausted attempts, a
    container killed mid-run — still satisfied "already ran today", so the sweep
    skipped that user until UTC midnight and their agent simply never ran. No
    log, no audit, no notification; from the user's side the product did nothing
    all day for no stated reason. A failed run is precisely the case that should
    be retried.
    """
    start = _start_of_today_db()
    with conn() as c:
        row = c.execute(
            "SELECT 1 FROM agent_runs WHERE user_id=? AND mode='live' "
            "AND status <> 'failed' AND created_at >= ? LIMIT 1",
            (uid, start),
        ).fetchone()
    return row is not None


def _start_of_today_db():
    """Midnight today, in the type this backend's DateTime columns use."""
    midnight = datetime.datetime.combine(
        datetime.date.today(), datetime.time.min, tzinfo=datetime.timezone.utc
    )
    return midnight if PG else int(midnight.timestamp() * 1000)


def promote_next_match(uid: str, n: int = 1) -> int:
    """Pull the next future-scheduled match(es) forward to right now.

    Called when a match the user was offered turns out to be a dead listing. The
    day's batch was sized on purpose; silently shrinking it because a posting
    closed sometime in the last three weeks would quietly starve the user of
    applications through no fault of theirs. Best-scored first.
    """
    if n <= 0:
        return 0
    with conn() as c:
        _ensure_app_columns(c)
        rows = c.execute(
            "SELECT id FROM applications WHERE user_id=? AND status='matched' "
            "AND scheduled_for IS NOT NULL AND scheduled_for > ? "
            "ORDER BY scheduled_for ASC, match_score DESC LIMIT ?",
            (uid, now_db(), n),
        ).fetchall()
        for r in rows:
            c.execute(
                "UPDATE applications SET scheduled_for=NULL WHERE id=?", (r["id"],)
            )
    return len(rows)


def ready_today_count(uid: str) -> int:
    """Matches the user can act on RIGHT NOW: due (or overdue), not future-dated.

    A null scheduled_for means "due immediately" — legacy rows written before the
    pipeline existed, and anything a human queued by hand. Mirrors the filter in
    src/app/api/applications/route.ts; the two must agree or the dashboard count
    won't match the list under it.
    """
    with conn() as c:
        _ensure_app_columns(c)
        row = c.execute(
            "SELECT COUNT(*) AS n FROM applications "
            "WHERE user_id=? AND status='matched' "
            "AND (scheduled_for IS NULL OR scheduled_for <= ?)",
            (uid, now_db()),
        ).fetchone()
    return int(row["n"] if row else 0)


def next_due_unnotified_match(uid: str) -> dict | None:
    """Return one released match that still needs its final link delivered."""
    with conn() as c:
        _ensure_app_columns(c)
        row = c.execute(
            "SELECT a.id, a.job_title, a.company, a.url, a.match_score, "
            "COALESCE(j.source, '') AS source "
            "FROM applications a LEFT JOIN jobs j ON j.id=a.job_id "
            "WHERE a.user_id=? AND a.status='matched' AND a.url IS NOT NULL "
            "AND a.notified_at IS NULL AND (a.scheduled_for IS NULL OR a.scheduled_for <= ?) "
            "ORDER BY a.scheduled_for ASC, a.created_at ASC LIMIT 1",
            (uid, now_db()),
        ).fetchone()
    return dict(row) if row else None


def has_due_unnotified_match(uid: str) -> bool:
    return next_due_unnotified_match(uid) is not None


def due_unnotified_matches(uid: str, limit: int = 50) -> list[dict]:
    """Every released-but-unnotified match, oldest first — so a user with several
    due at once (e.g. their first batch, or one who skipped a day) gets ONE
    notification listing all of them instead of a separate ping every sweep tick
    for each. See deliver_ready_match, which is what this feeds."""
    with conn() as c:
        _ensure_app_columns(c)
        rows = c.execute(
            "SELECT a.id, a.job_title, a.company, a.url, a.match_score, "
            "COALESCE(j.source, '') AS source "
            "FROM applications a LEFT JOIN jobs j ON j.id=a.job_id "
            "WHERE a.user_id=? AND a.status='matched' AND a.url IS NOT NULL "
            "AND a.notified_at IS NULL AND (a.scheduled_for IS NULL OR a.scheduled_for <= ?) "
            "ORDER BY a.scheduled_for ASC, a.created_at ASC LIMIT ?",
            (uid, now_db(), limit),
        ).fetchall()
    return [dict(r) for r in rows]


def due_matches_missing_kit(uid: str, limit: int = 20) -> list[dict]:
    """Matched-and-due rows, OR already-approved ("To submit") rows, that have no
    Apply Kit yet. `resume_version_id` is set together with the cover letter and
    any drafted answers by the same kit-generation step (see worker.py's
    post-scoring backfill), so its absence is the "not done yet" signal — cheaper
    than tracking a separate flag.

    Approved rows are included deliberately: that status means the user already
    clicked "Open & submit" — the exact moment the kit is most useful — so it
    must not be the one state where kit generation stops. (`matched` rows still
    need the schedule check since some are future-embargoed; an approved row
    could only have gotten there by already being due, so no separate check
    is needed for it.)

    Bounded to `limit` per run: kit generation is real work (LaTeX tailoring, an
    LLM call, and for platforms wired for it a read-only form visit), so this
    spreads that cost across a user's next few runs rather than one large burst
    if many rows ever came due unkitted at once.
    """
    with conn() as c:
        _ensure_app_columns(c)
        rows = c.execute(
            "SELECT a.id, a.job_title, a.company, a.url, "
            "COALESCE(j.source, '') AS source, COALESCE(j.skills, '[]') AS job_skills "
            "FROM applications a LEFT JOIN jobs j ON j.id=a.job_id "
            "WHERE a.user_id=? AND a.resume_version_id IS NULL AND ("
            "  (a.status='matched' AND (a.scheduled_for IS NULL OR a.scheduled_for <= ?))"
            "  OR a.status='approved'"
            ") "
            "ORDER BY a.scheduled_for ASC, a.created_at ASC LIMIT ?",
            (uid, now_db(), limit),
        ).fetchall()
    return [dict(r) for r in rows]


def set_application_kit(app_id: str, *, resume_version_id: str | None = None,
                        cover_letter_text: str | None = None,
                        answers_json: str | None = None) -> None:
    """Attach Apply Kit fields to an already-banked matched row without touching
    its status or reason. COALESCE on every column so a partial kit (e.g. a
    platform we can't read screening questions on yet) never blanks a field a
    previous call already set."""
    with conn() as c:
        _ensure_app_columns(c)
        c.execute(
            "UPDATE applications SET "
            "resume_version_id=COALESCE(?, resume_version_id), "
            "cover_letter=COALESCE(?, cover_letter), "
            "answers_json=COALESCE(?, answers_json) "
            "WHERE id=?",
            (resume_version_id, cover_letter_text, answers_json, app_id),
        )


def mark_match_notified(app_id: str) -> bool:
    """Atomically mark a final-link notification delivered."""
    with conn() as c:
        _ensure_app_columns(c)
        cursor = c.execute(
            "UPDATE applications SET notified_at=? WHERE id=? AND notified_at IS NULL",
            (now_db(), app_id),
        )
    return cursor.rowcount == 1


def _ensure_resume_versions_table(c):
    if PG:
        return
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
            tailored INTEGER NOT NULL DEFAULT 0,
            fit_score INTEGER,
            created_at INTEGER NOT NULL
        )
    """)
    cols = {row[1] for row in c.execute("PRAGMA table_info(resume_versions)").fetchall()}
    if "tailored" not in cols:
        c.execute("ALTER TABLE resume_versions ADD COLUMN tailored INTEGER NOT NULL DEFAULT 0")
    if "fit_score" not in cols:
        c.execute("ALTER TABLE resume_versions ADD COLUMN fit_score INTEGER")


def add_resume_version(uid: str, *, label: str, job_title: str, company: str,
                       text: str, file_path: str | None,
                       skills_claimed: list[str], base_skills: list[str],
                       tailored: bool = False, fit_score: int | None = None) -> str:
    """Immutable snapshot of the exact resume sent. Returns the version id to
    link onto the application row, so the user can later see (and download) the
    precise resume a recruiter received.

    `tailored` records whether this role got an edited resume at all, and
    `fit_score` records the number that made that call — so "why did my Acme
    application use a different resume than my Bolt one?" is answerable from the
    row, not from a guess.
    """
    vid = cuid()
    with conn() as c:
        _ensure_resume_versions_table(c)
        c.execute(
            "INSERT INTO resume_versions (id, user_id, label, job_title, company, "
            "text, file_path, skills_claimed, base_skills, tailored, fit_score, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (vid, uid, label, job_title, company, (text or "")[:40000], file_path,
             json.dumps(skills_claimed), json.dumps(base_skills),
             bool(tailored), fit_score, now_db()),
        )
    return vid


def _ensure_notifications_table(c):
    if PG:
        return
    c.execute("""
        CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            tier TEXT NOT NULL DEFAULT 'digest',
            channel TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            delivered INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        )
    """)


def add_notification(uid: str, *, channel: str, title: str, body: str,
                     delivered: bool, tier: str = "digest") -> None:
    """Record a delivery attempt and whether it actually landed.

    The `delivered` column existed from the start and nothing ever wrote it, so
    "did my user get their report?" was unanswerable — the only trace was a print
    in a container log. Now every attempt is on the record with its true outcome.
    """
    if not uid:
        return
    with conn() as c:
        _ensure_notifications_table(c)
        c.execute(
            "INSERT INTO notifications (id, user_id, tier, channel, title, body, "
            "delivered, created_at) VALUES (?,?,?,?,?,?,?,?)",
            (cuid(), uid, tier, channel, title[:200], body[:4000],
             bool(delivered), now_db()),
        )


def _ensure_audit_table(c):
    if PG:
        return
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
            (cuid(), user_id, action, target, detail, now_db()),
        )


def get_approved_applications(uid: str) -> list[dict]:
    """Return applications with status='approved' for this user, joined with job source.

    Carries the resolved destination (channel/tier/target) so the worker can send
    an approved row through the same employer channel discovery picked for it,
    instead of re-resolving it — the row is the record of that decision.
    """
    with conn() as c:
        _ensure_app_columns(c)
        rows = c.execute("""
            SELECT a.id, a.job_title, a.company, a.url, a.match_score,
                   a.apply_channel, a.apply_tier, a.apply_target,
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
                              screenshot_path: str | None = None,
                              answers_json: str | None = None,
                              blocking_facts: list[str] | None = None):
    with conn() as c:
        _ensure_app_columns(c)
        applied_at = now_db() if status == "applied" else None
        # COALESCE on the evidence columns: a later status change must never blank
        # out the proof screenshot or the screening answers already recorded for
        # this application.
        #
        # blocking_facts is the exception and is written straight through: it is
        # the CURRENT answer to "what is this waiting on", and the whole point is
        # that it clears the moment the user fills the box. COALESCEing it would
        # leave the dashboard asking for a date of birth that has been on file
        # for a week.
        c.execute(
            "UPDATE applications SET status=?, reason=?, failure_reason=?, "
            "screenshot_path=COALESCE(?, screenshot_path), "
            "resume_version_id=COALESCE(?, resume_version_id), "
            "answers_json=COALESCE(?, answers_json), "
            "blocking_facts=?, "
            "applied_at=? WHERE id=?",
            (status, reason, failure_reason, screenshot_path, resume_version_id,
             answers_json, json.dumps(blocking_facts) if blocking_facts else None,
             applied_at, app_id),
        )


def set_resume_analysis(uid: str, score: int, suggestions_json: str,
                        resume_hash: str | None = None):
    """Save resume quality score and full analysis JSON to the user's profile.

    `resume_hash` fingerprints the text the analysis was computed from, so the next
    run can tell whether anything actually changed instead of re-running the LLM.
    """
    with conn() as c:
        _ensure_profile_columns(c)
        _ensure_profile_row(c, uid)
        c.execute(
            "UPDATE profiles SET resume_score=?, resume_suggestions=?, "
            "resume_hash=COALESCE(?, resume_hash), updated_at=? WHERE user_id=?",
            (score, suggestions_json, resume_hash, now_db(), uid),
        )


def set_tex_status(uid: str, status: str, detail: str = ""):
    """Record whether the user's uploaded .tex is actually usable for tailoring."""
    with conn() as c:
        _ensure_profile_columns(c)
        _ensure_profile_row(c, uid)
        c.execute(
            "UPDATE profiles SET resume_tex_status=?, resume_tex_detail=?, "
            "updated_at=? WHERE user_id=?",
            (status, detail[:500], now_db(), uid),
        )


def set_resume_parse_failed(uid: str, failed: bool):
    """Flag whether resume parsing yielded no usable skills, so the dashboard can
    prompt the user to fill skills manually instead of silently scoring nothing."""
    with conn() as c:
        _ensure_profile_columns(c)
        _ensure_profile_row(c, uid)
        c.execute(
            "UPDATE profiles SET resume_parse_failed=?, updated_at=? WHERE user_id=?",
            (bool(failed), now_db(), uid),
        )


# ---------- ATS-optimized resume variants ----------

def _ensure_variants_table(c):
    if PG:
        return
    c.execute("""
        CREATE TABLE IF NOT EXISTS resume_variants (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            base_hash TEXT NOT NULL,
            rank INTEGER NOT NULL,
            label TEXT NOT NULL,
            score INTEGER NOT NULL,
            grade TEXT NOT NULL,
            baseline_score INTEGER NOT NULL,
            changes TEXT NOT NULL,
            pdf_path TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )
    """)


def set_variant_status(uid: str, status: str, detail: str = ""):
    """Drive the dashboard 'ATS-optimized versions' card:
    generating | ready | failed | no_gain | error
    (see Profile.resumeVariantStatus). "error" = our side broke — compiler or
    model down — and must never be worded as a verdict on the user's resume."""
    with conn() as c:
        _ensure_profile_columns(c)
        _ensure_profile_row(c, uid)
        c.execute(
            "UPDATE profiles SET resume_variant_status=?, resume_variant_detail=?, "
            "updated_at=? WHERE user_id=?",
            (status, (detail or "")[:500], now_db(), uid),
        )


def clear_resume_variants(uid: str):
    """Drop every stored variant for a user. Called before storing a fresh batch,
    and whenever the master resume changes (old variants describe a resume that no
    longer exists)."""
    with conn() as c:
        _ensure_variants_table(c)
        c.execute("DELETE FROM resume_variants WHERE user_id=?", (uid,))


def count_resume_variants(uid: str) -> int:
    """How many stored variants this user already has.

    Used to decide whether a run that produced nothing may clear them. It may
    not: the scores this feature compares against wander by several points on the
    same document, so a regeneration can come back empty purely by chance — and
    wiping a good batch on that would delete work the user could already see.
    """
    with conn() as c:
        _ensure_variants_table(c)
        row = c.execute(
            "SELECT COUNT(*) AS n FROM resume_variants WHERE user_id=?", (uid,)
        ).fetchone()
        return int(row["n"] if row else 0)


def save_resume_variants(uid: str, base_hash: str, variants: list[dict]):
    """Replace this user's variants with a freshly generated, ranked batch.

    `variants` is already sorted best-score-first; rank is assigned from that
    order. Each dict: {label, score, grade, baseline_score, changes: list, pdf_path}.
    The compiled PDFs are written to disk by the caller; we store only the path.
    """
    with conn() as c:
        _ensure_variants_table(c)
        c.execute("DELETE FROM resume_variants WHERE user_id=?", (uid,))
        for rank, v in enumerate(variants, start=1):
            c.execute(
                "INSERT INTO resume_variants (id, user_id, base_hash, rank, label, "
                "score, grade, baseline_score, changes, pdf_path, created_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (
                    cuid(), uid, base_hash, rank, str(v.get("label") or "")[:80],
                    int(v.get("score") or 0), str(v.get("grade") or "?")[:2],
                    int(v.get("baseline_score") or 0),
                    json.dumps(v.get("changes") or []),
                    str(v.get("pdf_path") or ""),
                    now_db(),
                ),
            )


def get_outcome_stats(uid: str) -> dict:
    """Return outcome stats for adaptive min_match_score adjustment.

    {total, interviews, rejected, rejection_rate, response_rate}
    rejection_rate = rejected / responded (excludes no_response)
    response_rate  = (interview+offer+rejected) / total
    Only counts applications where user has explicitly reported an outcome.
    """
    with conn() as c:
        _ensure_app_columns(c)
        rows = c.execute(
            "SELECT outcome FROM applications WHERE user_id=? AND status='applied' AND outcome IS NOT NULL",
            (uid,),
        ).fetchall()
    total = len(rows)
    if total == 0:
        return {"total": 0, "interviews": 0, "rejected": 0,
                "rejection_rate": 0.0, "response_rate": 0.0}
    interviews = sum(1 for r in rows if r["outcome"] in ("interview", "offer"))
    rejected   = sum(1 for r in rows if r["outcome"] == "rejected")
    no_resp    = sum(1 for r in rows if r["outcome"] == "no_response")
    responded  = total - no_resp
    return {
        "total":          total,
        "interviews":     interviews,
        "rejected":       rejected,
        "rejection_rate": rejected / responded if responded > 0 else 0.0,
        "response_rate":  responded / total,
    }


def report_already_sent(uid: str, date: str) -> bool:
    """Has this user already been told about this local day?

    A sweep can run several times a day (the scheduler, plus every "Run now"),
    and each pass used to deliver its own "daily" report — so an active user got
    the same summary three times before lunch, each with different numbers,
    which reads as the agent malfunctioning. The report is once per user per
    local date; later runs update the row and stay quiet.
    """
    try:
        with conn() as c:
            row = c.execute(
                "SELECT 1 FROM reports WHERE user_id=? AND date=? AND delivered=? LIMIT 1",
                (uid, date, True),
            ).fetchone()
        return bool(row)
    except Exception as e:  # noqa: BLE001 — never let this decide by crashing
        print(f"[db] report dedupe check failed: {e}")
        return False


def add_report(uid: str, *, date: str, matched: int, applied: int, failed: int,
               summary: str, delivered: bool):
    with conn() as c:
        c.execute(
            "INSERT INTO reports (id, user_id, date, matched_count, applied_count, "
            "failed_count, summary, delivered, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (cuid(), uid, date, matched, applied, failed, summary,
             bool(delivered), now_db()),
        )


# ---------- daily cap: reservation, not a recount ----------

def _ensure_daily_usage_table(c):
    if PG:
        return  # Prisma owns the schema on Postgres
    c.execute("""
        CREATE TABLE IF NOT EXISTS daily_usage (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            local_date TEXT NOT NULL,
            submitted INTEGER NOT NULL DEFAULT 0,
            attempted INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        )
    """)
    c.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS daily_usage_user_date "
        "ON daily_usage(user_id, local_date)"
    )


def local_date_for(uid: str, tz_name: str | None = None) -> str:
    """The user's LOCAL calendar date as YYYY-MM-DD.

    The cap is "N per day" in the user's day, not UTC's — otherwise the window
    slides for everyone outside UTC and an IST user's allowance resets at 5:30am.
    Falls back to the fleet default when the zone is missing or unknown rather
    than raising: a bad timezone string must not stop a run.
    """
    import datetime as _dt
    name = tz_name or "Asia/Kolkata"
    try:
        from zoneinfo import ZoneInfo
        now = _dt.datetime.now(ZoneInfo(name))
    except Exception:  # noqa: BLE001 — unknown zone, or no tzdata on the host
        now = _dt.datetime.now(_dt.timezone(_dt.timedelta(hours=5, minutes=30)))
    return now.strftime("%Y-%m-%d")


def reserve_daily_slot(uid: str, cap: int, tz_name: str | None = None, day: str | None = None) -> bool:
    """Claim one of today's application slots. True = it is yours to spend.

    This is the concurrency-safe half of the daily cap. Counting rows and then
    deciding cannot bound anything: two workers both read 4-of-5, both conclude
    there is room, and both submit — six applications under a limit of five, and
    a sent application cannot be recalled.

    The UPDATE carries the limit in its own WHERE clause, so the database
    decides. Whoever loses the race updates zero rows and is told no. Call this
    IMMEDIATELY before the send, and release_daily_slot() only when it is
    certain nothing was submitted.
    """
    if cap <= 0:
        return False
    day = day or local_date_for(uid, tz_name)
    with conn() as c:
        _ensure_daily_usage_table(c)
        # Make sure the row exists without disturbing an existing count.
        try:
            c.execute(
                "INSERT INTO daily_usage (id, user_id, local_date, submitted, attempted, updated_at) "
                "VALUES (?,?,?,0,0,?) ON CONFLICT (user_id, local_date) DO NOTHING",
                (cuid(), uid, day, now_db()),
            )
        except Exception:  # noqa: BLE001 — racing insert lost; the row is there either way
            pass
        cur = c.execute(
            "UPDATE daily_usage SET submitted = submitted + 1, attempted = attempted + 1, "
            "updated_at = ? WHERE user_id = ? AND local_date = ? AND submitted < ?",
            (now_db(), uid, day, cap),
        )
        return cur.rowcount == 1


def release_daily_slot(uid: str, tz_name: str | None = None, day: str | None = None) -> None:
    """Give back a reserved slot — ONLY when it is certain nothing was sent.

    An ambiguous submit (posted, confirmation unreadable) must NOT come back
    here: it may well have reached the employer, and refunding it would let the
    same user exceed the number of applications they agreed to per day. Keeps
    `attempted` so the reservation still leaves a trace.

    `day` should be the SAME date string the reservation was taken under — a
    release that recomputes "today" at 00:01 decrements the wrong day's row
    (and the submitted>0 guard silently drops it), leaving yesterday's slot
    spent forever. The TS mirror (browserTasks.releaseDailySlot) already takes
    the stored reservedDate for exactly this reason.
    """
    day = day or local_date_for(uid, tz_name)
    with conn() as c:
        _ensure_daily_usage_table(c)
        c.execute(
            "UPDATE daily_usage SET submitted = submitted - 1, updated_at = ? "
            "WHERE user_id = ? AND local_date = ? AND submitted > 0",
            (now_db(), uid, day),
        )


def daily_usage(uid: str, tz_name: str | None = None) -> dict:
    """Today's {submitted, attempted} for this user, in their local day."""
    day = local_date_for(uid, tz_name)
    with conn() as c:
        _ensure_daily_usage_table(c)
        row = c.execute(
            "SELECT submitted, attempted FROM daily_usage WHERE user_id=? AND local_date=?",
            (uid, day),
        ).fetchone()
    return {
        "submitted": (row["submitted"] if row else 0) or 0,
        "attempted": (row["attempted"] if row else 0) or 0,
        "date": day,
    }


def add_application_event(app_id: str, event_type: str, actor: str = "worker",
                          meta: dict | None = None) -> None:
    """Append one entry to an application's timeline.

    Best-effort by construction: a timeline write must never be the thing that
    fails a real submission. `meta` is small JSON and must never carry resume
    text, answers or contact details — this table is read by admin views and
    rendered into reports.
    """
    try:
        with conn() as c:
            if not PG:
                c.execute("""
                    CREATE TABLE IF NOT EXISTS application_events (
                        id TEXT PRIMARY KEY,
                        application_id TEXT NOT NULL,
                        type TEXT NOT NULL,
                        actor TEXT NOT NULL DEFAULT 'worker',
                        meta TEXT,
                        created_at INTEGER NOT NULL
                    )
                """)
            c.execute(
                "INSERT INTO application_events (id, application_id, type, actor, meta, created_at) "
                "VALUES (?,?,?,?,?,?)",
                (cuid(), app_id, event_type, actor,
                 json.dumps(meta)[:1000] if meta else None, now_db()),
            )
    except Exception as e:  # noqa: BLE001
        print(f"[db] application event {event_type} not recorded: {e}")


# ---------- idempotency: never send the same application twice ----------

def _ensure_submissions_table(c):
    if PG:
        c.execute("""
            CREATE TABLE IF NOT EXISTS submission_receipts (
                key TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                status TEXT NOT NULL,
                detail TEXT,
                created_at TIMESTAMP(3) NOT NULL
            )
        """)
        return
    c.execute("""
        CREATE TABLE IF NOT EXISTS submission_receipts (
            key TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            status TEXT NOT NULL,
            detail TEXT,
            created_at INTEGER NOT NULL
        )
    """)


def submission_key(uid: str, job_url: str, channel: str, target: str = "") -> str:
    """Stable identity for "this user applying to this job through this channel".

    Includes the channel and target because the SAME listing can legitimately be
    submitted twice by different routes (a Google Form today, the board later if
    routing changes) — and must never be submitted twice by the SAME route.
    """
    import hashlib
    raw = f"{uid}\x1f{(job_url or '').strip().lower()}\x1f{channel}\x1f{(target or '').strip().lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def claim_submission(key: str, uid: str) -> bool:
    """Reserve the right to send this exact application. False = already sent.

    A queue message can be redelivered — a worker crash after the POST but
    before the status write, a retry of an ambiguous timeout, a run reclaimed by
    reclaim_stale. Without this the second attempt sends a duplicate application
    to a real employer under the user's name, which cannot be undone and reads
    to a recruiter as spam.

    The INSERT is the lock: the primary key makes the database reject the second
    claimant rather than two workers agreeing they are both first.
    """
    try:
        with conn() as c:
            _ensure_submissions_table(c)
            cur = c.execute(
                "INSERT INTO submission_receipts (key, user_id, status, created_at) "
                "VALUES (?,?,?,?) ON CONFLICT (key) DO NOTHING",
                (key, uid, "in_flight", now_db()),
            )
            return cur.rowcount == 1
    except Exception as e:  # noqa: BLE001
        # Fail CLOSED: if the ledger is unreachable we cannot prove this is not a
        # duplicate, and re-sending is worse than skipping.
        print(f"[db] submission claim failed for {key[:12]}: {e}")
        return False


def record_submission(key: str, status: str, detail: str = "") -> None:
    """Write the outcome onto a claimed submission (the receipt)."""
    try:
        with conn() as c:
            _ensure_submissions_table(c)
            c.execute(
                "UPDATE submission_receipts SET status=?, detail=? WHERE key=?",
                (status, (detail or "")[:300], key),
            )
    except Exception as e:  # noqa: BLE001
        print(f"[db] receipt write failed for {key[:12]}: {e}")


def release_submission(key: str) -> None:
    """Delete a claim when the send DEFINITELY did not happen, so a genuine
    retry is possible later.

    Only for definite non-sends. An ambiguous outcome keeps its claim on purpose:
    the application may well have reached the employer, and a retry that turns
    out to be a duplicate is the failure this whole ledger exists to prevent.
    """
    try:
        with conn() as c:
            _ensure_submissions_table(c)
            c.execute("DELETE FROM submission_receipts WHERE key=?", (key,))
    except Exception as e:  # noqa: BLE001
        print(f"[db] receipt release failed for {key[:12]}: {e}")


# ---------- browser tasks: work only the user's own browser can do ----------

def _ensure_browser_tasks_table(c):
    if PG:
        return  # Prisma owns the schema on Postgres
    c.execute("""
        CREATE TABLE IF NOT EXISTS browser_tasks (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            application_id TEXT NOT NULL,
            url TEXT NOT NULL,
            host TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'queued',
            lease_token_hash TEXT,
            lease_expires_at INTEGER,
            heartbeat_at INTEGER,
            attempts INTEGER NOT NULL DEFAULT 0,
            blocked_reason TEXT,
            receipt TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    """)


def enqueue_browser_task(uid: str, application_id: str, url: str) -> str | None:
    """Hand one application to the user's own browser.

    This is the producer the extension consumes. A board application cannot be
    submitted from our servers — that is the user's account, on a site that
    forbids automation — but it CAN be completed in their own browser, in their
    own session, with any CAPTCHA going to them. Without a row here the whole
    executor has nothing to claim, which is exactly how the feature shipped
    complete and did nothing.

    Idempotent per application: a sweep runs many times a day and must not
    enqueue the same application again on each pass.
    """
    if not (application_id and url):
        return None
    try:
        from urllib.parse import urlparse
        host = (urlparse(url).hostname or "").lower()
        if not host:
            return None
        with conn() as c:
            _ensure_browser_tasks_table(c)
            existing = c.execute(
                "SELECT id FROM browser_tasks WHERE application_id=? "
                "AND state NOT IN ('failed','cancelled') LIMIT 1",
                (application_id,),
            ).fetchone()
            if existing:
                return existing["id"]
            tid = cuid()
            now = now_db()
            c.execute(
                "INSERT INTO browser_tasks (id, user_id, application_id, url, host, "
                "state, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (tid, uid, application_id, url, host, "queued", 0, now, now),
            )
        return tid
    except Exception as e:  # noqa: BLE001 — never fail a run over queueing extra work
        print(f"[db] browser task not queued for {application_id}: {e}")
        return None
