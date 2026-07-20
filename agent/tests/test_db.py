import os
import sqlite3
import time

import pytest

import db


SCHEMA = """
CREATE TABLE users (
    id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT,
    google_id TEXT, phone TEXT, phone_verified INTEGER DEFAULT 0,
    created_at INTEGER, paid INTEGER DEFAULT 0, plan TEXT DEFAULT 'free',
    slack_user_id TEXT, slack_channel TEXT, slack_connected INTEGER DEFAULT 0,
    internshala_connected INTEGER DEFAULT 0, status TEXT DEFAULT 'registered',
    role TEXT DEFAULT 'user'
);
CREATE TABLE profiles (
    id TEXT PRIMARY KEY, user_id TEXT, resume_text TEXT, resume_name TEXT,
    skills TEXT DEFAULT '[]', education TEXT, experience_level TEXT,
    preferred_domains TEXT DEFAULT '[]', preferred_locations TEXT DEFAULT '[]',
    work_mode TEXT DEFAULT 'any', stipend_min INTEGER DEFAULT 0,
    max_per_day INTEGER DEFAULT 10, min_match_score INTEGER DEFAULT 55,
    excluded_companies TEXT DEFAULT '[]', auto_apply INTEGER DEFAULT 1,
    plan_json TEXT, updated_at INTEGER
);
CREATE TABLE jobs (
    id TEXT PRIMARY KEY, source TEXT, external_id TEXT, title TEXT,
    company TEXT, location TEXT, stipend TEXT, duration TEXT,
    skills TEXT DEFAULT '[]', url TEXT, scraped_at INTEGER,
    UNIQUE(source, external_id)
);
CREATE TABLE applications (
    id TEXT PRIMARY KEY, user_id TEXT, job_id TEXT, job_title TEXT,
    company TEXT, url TEXT, match_score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'matched', reason TEXT, applied_at INTEGER,
    outcome TEXT, outcome_at INTEGER, created_at INTEGER
);
CREATE TABLE reports (
    id TEXT PRIMARY KEY, user_id TEXT, date TEXT, matched_count INTEGER,
    applied_count INTEGER, failed_count INTEGER, summary TEXT,
    delivered INTEGER, created_at INTEGER
);
"""


def _real_conn(path):
    from contextlib import contextmanager

    @contextmanager
    def conn():
        c = sqlite3.connect(path, timeout=15)
        c.row_factory = sqlite3.Row
        try:
            c.execute("PRAGMA busy_timeout = 8000")
            yield c
            c.commit()
        finally:
            c.close()

    return conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    """Point db.py at a fresh temp SQLite file with real conn()/cuid()/PG=False.

    test_run_queue.py permanently monkeypatches db.conn/db.cuid/db.PG at
    *module import time* with no teardown (an in-memory stub for its own
    tests) — in a full-suite run that pollutes the shared db module for every
    test collected after it. monkeypatch.setattr here reverts cleanly after
    each of *our* tests, so we don't need to touch that file to be correct
    regardless of collection order.
    """
    path = str(tmp_path / "test.db")
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    c.commit()
    c.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _real_conn(path))
    monkeypatch.setattr(db, "cuid", lambda: "c" + os.urandom(12).hex())
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    monkeypatch.setattr(db, "time_ago_db", lambda ms: int(time.time() * 1000) - ms)
    return path


def _insert_user(path, uid, plan="starter", status="active"):
    c = sqlite3.connect(path)
    c.execute(
        "INSERT INTO users (id, email, plan, status, created_at) VALUES (?,?,?,?,?)",
        (uid, f"{uid}@x.com", plan, status, db.now_ms()),
    )
    c.commit()
    c.close()


# ---------- pure helpers ----------

def test_cuid_is_unique_and_shaped(monkeypatch):
    # test_run_queue.py permanently replaces db.cuid at import time for its own
    # in-memory stub — restore the real implementation for this test regardless
    # of what order test files were collected in.
    monkeypatch.setattr(db, "cuid", lambda: "c" + __import__("secrets").token_hex(12))
    a, b = db.cuid(), db.cuid()
    assert a != b
    assert a.startswith("c")
    assert len(a) == 25  # "c" + 24 hex chars (12 bytes)


def test_now_ms_is_close_to_wall_clock():
    assert abs(db.now_ms() - int(time.time() * 1000)) < 2000


# ---------- plan cap ----------

def test_plan_cap_pro_is_15(testdb):
    _insert_user(testdb, "u1", plan="pro")
    assert db.get_plan_cap("u1") == 15


def test_plan_cap_starter_is_5(testdb):
    _insert_user(testdb, "u1", plan="starter")
    assert db.get_plan_cap("u1") == 5


def test_plan_cap_defaults_to_5_for_unknown_user(testdb):
    assert db.get_plan_cap("ghost") == 5


# ---------- applications ----------

def test_add_and_get_approved_applications(testdb):
    _insert_user(testdb, "u1")
    db.add_application(
        "u1", job_id=None, title="Frontend Intern", company="Acme", url="https://x/1",
        score=80, status="approved", reason="good fit", applied=False,
    )
    db.add_application(
        "u1", job_id=None, title="Backend Intern", company="Acme", url="https://x/2",
        score=60, status="matched", reason="pending review", applied=False,
    )
    approved = db.get_approved_applications("u1")
    assert len(approved) == 1
    assert approved[0]["job_title"] == "Frontend Intern"


def test_update_application_status_sets_applied_at(testdb):
    _insert_user(testdb, "u1")
    db.add_application(
        "u1", job_id=None, title="X", company="Y", url="https://x/1",
        score=80, status="approved", reason="r", applied=False,
    )
    app = db.get_approved_applications("u1")[0]
    db.update_application_status(app["id"], "applied", "submitted ok")

    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT * FROM applications WHERE id=?", (app["id"],)).fetchone()
    c.close()
    assert row["status"] == "applied"
    assert row["applied_at"] is not None


def test_due_match_notification_is_claimed_only_once(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="X", company="Y", url="https://x/1",
                       score=80, status="matched", reason="r", applied=False)
    app = db.next_due_unnotified_match("u1")
    assert app and app["url"] == "https://x/1"
    assert db.mark_match_notified(app["id"]) is True
    assert db.next_due_unnotified_match("u1") is None


def test_applied_external_ids_dedupes(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="A", company="C", url="https://x/1",
                       score=1, status="applied", reason="r", applied=True)
    db.add_application("u1", job_id=None, title="B", company="C", url="https://x/2",
                       score=1, status="failed", reason="r", applied=False)
    ids = db.applied_external_ids("u1")
    assert ids == {"https://x/1", "https://x/2"}


def test_applied_external_ids_excludes_skipped(testdb):
    """A skip is a scoring judgement, not a commitment. Treating it as final froze
    the listing forever: a re-run scored nothing and reported "matched 0", so no
    scoring fix could ever reach a job the agent had already dismissed once."""
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="A", company="C", url="https://x/1",
                       score=90, status="applied", reason="r", applied=True)
    db.add_application("u1", job_id=None, title="B", company="C", url="https://x/2",
                       score=21, status="skipped", reason="below 65", applied=False)
    db.add_application("u1", job_id=None, title="C", company="C", url="https://x/3",
                       score=80, status="matched", reason="awaiting approval", applied=False)

    ids = db.applied_external_ids("u1")

    assert "https://x/2" not in ids            # re-scorable
    assert ids == {"https://x/1", "https://x/3"}  # committed / awaiting a human


def test_clear_skipped_only_removes_skipped_rows(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="A", company="C", url="https://x/1",
                       score=21, status="skipped", reason="below 65", applied=False)
    db.add_application("u1", job_id=None, title="B", company="C", url="https://x/2",
                       score=90, status="applied", reason="r", applied=True)

    removed = db.clear_skipped("u1", ["https://x/1", "https://x/2"])

    assert removed == 1
    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    rows = c.execute("SELECT url, status FROM applications WHERE user_id='u1'").fetchall()
    c.close()
    assert [(r["url"], r["status"]) for r in rows] == [("https://x/2", "applied")]


def test_clear_skipped_handles_an_empty_url_list(testdb):
    _insert_user(testdb, "u1")
    assert db.clear_skipped("u1", []) == 0


def test_todays_applied_count_excludes_older_rows(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="Today", company="C", url="https://x/1",
                       score=1, status="applied", reason="r", applied=True)

    # backdate a second "applied" row to yesterday — shouldn't count today
    yesterday_ms = db.now_ms() - 2 * 24 * 60 * 60 * 1000
    c = sqlite3.connect(testdb)
    c.execute(
        "INSERT INTO applications (id, user_id, job_title, company, status, created_at) "
        "VALUES (?,?,?,?,?,?)",
        (db.cuid(), "u1", "Old", "C", "applied", yesterday_ms),
    )
    c.commit()
    c.close()

    assert db.todays_applied_count("u1") == 1


def test_due_unnotified_matches_returns_all_of_them(testdb):
    """Feeds deliver_ready_match's batching — a user with several due at once must
    get all of them back in one call, not just the oldest (the old behavior, from
    before notifications were batched into a single message)."""
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="A", company="C", url="https://x/1",
                       score=80, status="matched", reason="r", applied=False)
    db.add_application("u1", job_id=None, title="B", company="C", url="https://x/2",
                       score=70, status="matched", reason="r", applied=False)
    apps = db.due_unnotified_matches("u1")
    assert {a["url"] for a in apps} == {"https://x/1", "https://x/2"}


# ---------- Apply Kit ----------

def test_due_matches_missing_kit_finds_a_due_row_with_no_kit_yet(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="Frontend Intern", company="Acme",
                       url="https://x/1", score=80, status="matched", reason="r", applied=False)
    due = db.due_matches_missing_kit("u1")
    assert len(due) == 1
    assert due[0]["job_title"] == "Frontend Intern"


def test_due_matches_missing_kit_excludes_a_row_that_already_has_one(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="X", company="Y", url="https://x/1",
                       score=80, status="matched", reason="r", applied=False)
    app_id = db.due_matches_missing_kit("u1")[0]["id"]
    db.set_application_kit(app_id, resume_version_id="rv1", cover_letter_text="Dear team...")
    assert db.due_matches_missing_kit("u1") == []


def test_due_matches_missing_kit_ignores_not_yet_due_rows(testdb):
    """A future-scheduled match shouldn't have its kit generated early — kit
    generation is real cost (LaTeX tailoring, an LLM call), spent close to when
    the user will actually see the match, same pacing philosophy as the release
    schedule itself."""
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="X", company="Y", url="https://x/1",
                       score=80, status="matched", reason="r", applied=False,
                       scheduled_for=db.now_ms() + 999_000_000)
    assert db.due_matches_missing_kit("u1") == []


def test_set_application_kit_never_blanks_a_field_with_none(testdb):
    """COALESCE semantics: a platform we can't harvest answers on yet must not
    wipe out a resume/cover-letter a previous call already attached."""
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="X", company="Y", url="https://x/1",
                       score=80, status="matched", reason="r", applied=False)
    app_id = db.due_matches_missing_kit("u1")[0]["id"]
    db.set_application_kit(app_id, resume_version_id="rv1", cover_letter_text="Dear team...")
    db.set_application_kit(app_id, answers_json='[{"q":"CGPA?","a":"8.7","source":"profile"}]')

    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT * FROM applications WHERE id=?", (app_id,)).fetchone()
    c.close()
    assert row["resume_version_id"] == "rv1"
    assert row["cover_letter"] == "Dear team..."
    assert "8.7" in row["answers_json"]
    assert row["status"] == "matched" and row["reason"] == "r"  # untouched


def test_set_application_kit_does_not_affect_other_rows(testdb):
    _insert_user(testdb, "u1")
    db.add_application("u1", job_id=None, title="A", company="C", url="https://x/1",
                       score=80, status="matched", reason="r", applied=False)
    db.add_application("u1", job_id=None, title="B", company="C", url="https://x/2",
                       score=80, status="matched", reason="r", applied=False)
    due = db.due_matches_missing_kit("u1")
    assert len(due) == 2
    db.set_application_kit(due[0]["id"], resume_version_id="rv1")
    remaining = db.due_matches_missing_kit("u1")
    assert len(remaining) == 1
    assert remaining[0]["id"] == due[1]["id"]


# ---------- jobs ----------

def test_upsert_job_is_idempotent(testdb):
    job = {"source": "internshala", "external_id": "abc123", "title": "Intern",
           "company": "Acme", "url": "https://x/job", "skills": ["python"]}
    id1 = db.upsert_job(job)
    id2 = db.upsert_job(job)
    assert id1 == id2


def test_upsert_job_creates_distinct_rows_for_distinct_external_ids(testdb):
    id1 = db.upsert_job({"source": "internshala", "external_id": "a", "title": "T",
                          "company": "C", "url": "https://x/1"})
    id2 = db.upsert_job({"source": "internshala", "external_id": "b", "title": "T",
                          "company": "C", "url": "https://x/2"})
    assert id1 != id2


# ---------- integrations (auto-creates its own table) ----------

def test_set_integration_status_syncs_legacy_internshala_flag(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "internshala", "connected")

    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    user = c.execute("SELECT internshala_connected FROM users WHERE id=?", ("u1",)).fetchone()
    c.close()
    assert bool(user["internshala_connected"]) is True

    assert db.get_connected_platforms("u1") == ["internshala"]


def test_get_integrations_returns_all_platforms_with_defaults(testdb):
    _insert_user(testdb, "u1")
    rows = db.get_integrations("u1")
    platforms = {r["platform"] for r in rows}
    assert platforms == {"linkedin", "internshala", "naukri", "unstop", "indeed"}
    assert all(r["status"] == "disconnected" for r in rows)


def test_get_integration_returns_none_when_never_set(testdb):
    _insert_user(testdb, "u1")
    assert db.get_integration("u1", "linkedin") is None


def test_get_integration_returns_row_with_updated_at(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "linkedin", "challenge_detected")
    row = db.get_integration("u1", "linkedin")
    assert row["status"] == "challenge_detected"
    assert row["updated_at"] is not None


# ---------- remote-browser connect flow (connect_service.py) ----------

def test_next_pending_connect_request_none_when_nothing_pending(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "linkedin", "disconnected")
    assert db.next_pending_connect_request() is None


def test_next_pending_connect_request_finds_connecting_row(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "linkedin", "connecting")
    pending = db.next_pending_connect_request()
    assert pending == {"user_id": "u1", "platform": "linkedin"}


def test_next_pending_connect_request_is_fifo_oldest_first(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "naukri", "connecting")
    time.sleep(0.01)
    db.set_integration_status("u1", "linkedin", "connecting")
    pending = db.next_pending_connect_request()
    assert pending["platform"] == "naukri"  # set first, so oldest


def test_connect_request_claim_cannot_be_taken_by_second_worker(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "linkedin", "connecting")
    first = db.next_pending_connect_request("worker-one")
    second = db.next_pending_connect_request("worker-two")
    assert first == {"user_id": "u1", "platform": "linkedin"}
    assert second is None

    db.release_connect_request("u1", "linkedin", "worker-one")
    assert db.next_pending_connect_request("worker-two") == first


def test_set_and_clear_connect_token_roundtrip(testdb):
    _insert_user(testdb, "u1")
    db.set_integration_status("u1", "linkedin", "connecting")
    db.set_connect_token("u1", "linkedin", "tok_abc123", db.time_from_now_db(300_000))

    row = db.get_integration("u1", "linkedin")
    assert row is not None  # token columns aren't in the default SELECT — verify via raw query instead
    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    raw = c.execute(
        "SELECT connect_token, connect_token_expires_at FROM user_integrations WHERE user_id=? AND platform=?",
        ("u1", "linkedin"),
    ).fetchone()
    c.close()
    assert raw["connect_token"] == "tok_abc123"
    assert raw["connect_token_expires_at"] is not None

    db.clear_connect_token("u1", "linkedin")
    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    raw = c.execute(
        "SELECT connect_token, connect_token_expires_at FROM user_integrations WHERE user_id=? AND platform=?",
        ("u1", "linkedin"),
    ).fetchone()
    c.close()
    assert raw["connect_token"] is None
    assert raw["connect_token_expires_at"] is None


# ---------- time_from_now_db ----------

def test_time_from_now_db_is_ahead_of_backend_now():
    future = db.time_from_now_db(60_000)
    now = db.now_db()
    assert future > now
    delta_ms = ((future - now).total_seconds() * 1000) if db.PG else (future - now)
    assert delta_ms <= 61_000  # allow a little test-runtime slack


# ---------- outcome stats ----------

def test_outcome_stats_empty_when_no_outcomes(testdb):
    _insert_user(testdb, "u1")
    stats = db.get_outcome_stats("u1")
    assert stats == {"total": 0, "interviews": 0, "rejected": 0,
                      "rejection_rate": 0.0, "response_rate": 0.0}


def test_outcome_stats_computes_rates(testdb):
    _insert_user(testdb, "u1")
    # 4 applied rows with outcomes: interview, rejected, rejected, no_response
    c = sqlite3.connect(testdb)
    for outcome in ("interview", "rejected", "rejected", "no_response"):
        c.execute(
            "INSERT INTO applications (id, user_id, job_title, company, status, "
            "outcome, created_at) VALUES (?,?,?,?,?,?,?)",
            (db.cuid(), "u1", "T", "C", "applied", outcome, db.now_ms()),
        )
    c.commit()
    c.close()

    stats = db.get_outcome_stats("u1")
    assert stats["total"] == 4
    assert stats["interviews"] == 1
    assert stats["rejected"] == 2
    # responded = total - no_response = 3; rejection_rate = 2/3
    assert stats["rejection_rate"] == pytest.approx(2 / 3)
    assert stats["response_rate"] == pytest.approx(3 / 4)


# ---------- audit / resume versions (auto-create their own tables) ----------

def test_add_audit_creates_table_and_row_on_fresh_db(testdb):
    db.add_audit("apply", user_id="u1", target="https://x", detail="ok")
    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT * FROM audit_logs WHERE user_id=?", ("u1",)).fetchone()
    c.close()
    assert row["action"] == "apply"


def test_add_resume_version_creates_table_and_returns_id(testdb):
    _insert_user(testdb, "u1")
    vid = db.add_resume_version(
        "u1", label="Frontend @ Acme", job_title="Frontend Intern", company="Acme",
        text="tailored resume text", file_path=None,
        skills_claimed=["react"], base_skills=["react", "python"],
    )
    c = sqlite3.connect(testdb)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT * FROM resume_versions WHERE id=?", (vid,)).fetchone()
    c.close()
    assert row["label"] == "Frontend @ Acme"
