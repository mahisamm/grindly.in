"""A browser that never launched sent nothing — the listing must stay reachable.

The 2026-07-31 dead-Xvfb run marked 7 real listings 'failed'. Every lock in the
system then agreed they were spent: applied_external_ids burned the URL,
committed_role_keys burned the (company, title) pair, and clear_skipped refused
to replace the row. No employer had received a byte. These tests pin the
unlock: failure_reason='browser_launch' is provably pre-submit and behaves like
a skip, while every other failed row stays locked (a timeout can fire AFTER the
submit click landed).
"""
import os
import sqlite3
import time

import pytest

import db
from tests.test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "unlock.db")
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    c.commit()
    c.close()
    monkeypatch.setattr(db, "DB_PATH", path)
    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _real_conn(path))
    monkeypatch.setattr(db, "cuid", lambda: "c" + os.urandom(12).hex())
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    return path


def _failed(uid, url, *, reason="could not start a browser: launch died",
            failure="browser_launch", company="Acme", title="SDE Intern"):
    db.add_application(
        uid, job_id=None, title=title, company=company, url=url,
        score=80, status="failed", reason=reason, applied=False,
        failure_reason=failure,
    )


def test_launch_failed_url_is_rescorable(testdb):
    _failed("u1", "https://x/1")
    assert "https://x/1" not in db.applied_external_ids("u1")


def test_other_failed_urls_stay_locked(testdb):
    # Ambiguous failures (a timeout can post-date the click) must stay burned.
    _failed("u1", "https://x/1", reason="navigation timed out", failure="timeout")
    assert "https://x/1" in db.applied_external_ids("u1")


def test_launch_failed_role_key_is_not_committed(testdb):
    _failed("u1", "https://x/1", company="CloudSEK", title="SDE Intern")
    assert ("cloudsek", "sde intern") not in db.committed_role_keys("u1")


def test_other_failed_role_keys_stay_committed(testdb):
    _failed("u1", "https://x/1", reason="navigation timed out",
            failure="timeout", company="CloudSEK", title="SDE Intern")
    assert ("cloudsek", "sde intern") in db.committed_role_keys("u1")


def test_clear_skipped_replaces_launch_failed_rows(testdb):
    _failed("u1", "https://x/1")
    assert db.clear_skipped("u1", ["https://x/1"]) == 1


def test_repair_reclassifies_the_2026_07_31_rows(testdb):
    # Written before BROWSER_LAUNCH existed: "browser has been closed"
    # matched the "closed" branch and landed in listing_closed.
    _failed("u1", "https://x/1",
            reason="could not start a browser: BrowserType.launch: Target "
                   "page, context or browser has been closed",
            failure="listing_closed")
    assert "https://x/1" in db.applied_external_ids("u1")
    assert db.repair_misclassified_launch_failures() == 1
    assert "https://x/1" not in db.applied_external_ids("u1")
    # Idempotent — the worker runs it on every boot.
    assert db.repair_misclassified_launch_failures() == 0


def test_repair_never_touches_genuine_closures(testdb):
    _failed("u1", "https://x/1", reason="listing closed — no longer accepting",
            failure="listing_closed")
    assert db.repair_misclassified_launch_failures() == 0
    assert "https://x/1" in db.applied_external_ids("u1")
