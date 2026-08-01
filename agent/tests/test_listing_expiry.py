"""A pool that never expires is a pool of ghosts.

Without expiry the shared index only grows, and the agent spends a user's daily
quota applying to roles that closed months ago. From the dashboard that is
indistinguishable from an agent working perfectly — five applications a day,
every day, all of them into the void.

The expiry itself shipped as a db function and then, for one commit, was called
by nothing at all. These tests exist so it stays wired.
"""
import datetime
import os
import sqlite3
import time

import pytest

import db
import sweep

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "expiry.db")
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


def _seed(ext, days_ago=0):
    jid = db.upsert_job({
        "source": "atsboards", "external_id": ext, "title": "Intern",
        "company": "Acme", "url": f"https://acme.test/{ext}", "skills": [],
    })
    if days_ago:
        with db.conn() as c:
            c.execute("UPDATE jobs SET last_seen_at=? WHERE id=?",
                      (db.time_ago_db(days_ago * 86400 * 1000), jid))
    return jid


def test_a_long_unseen_listing_is_retired(testdb):
    old = _seed("old", days_ago=40)
    fresh = _seed("fresh")
    assert sweep.retire_stale_listings() == 1
    assert db.get_job(old)["dead_at"] is not None
    assert db.get_job(fresh)["dead_at"] is None


def test_a_listing_missed_by_a_couple_of_runs_is_not_retired(testdb):
    """Search is not exhaustive. A posting that two runs happened to miss is
    still open, and retiring it for that would shrink the pool faster than the
    crawler grows it."""
    recent = _seed("recent", days_ago=5)
    assert sweep.retire_stale_listings() == 0
    assert db.get_job(recent)["dead_at"] is None


def test_a_retired_listing_stops_being_offered(testdb):
    _seed("old", days_ago=40)
    live = _seed("live")
    sweep.retire_stale_listings()
    assert [j["id"] for j in db.live_jobs()] == [live]


def test_expiry_runs_before_the_harvest_not_after(testdb, monkeypatch):
    """The harvest re-sights everything still live, refreshing last_seen_at. Run
    afterwards, expiry would retire listings the same run had just confirmed
    were alive — and then the next harvest would resurrect them, forever."""
    order = []
    monkeypatch.setattr(sweep, "retire_stale_listings", lambda *a, **k: order.append("expire"))
    monkeypatch.setattr(sweep, "harvest_due", lambda *a, **k: True)
    monkeypatch.setattr(sweep, "_last_harvest_date", "", raising=False)

    import sys
    import types
    fake = types.ModuleType("harvester")
    fake.sweep = lambda: order.append("harvest") or {
        "learned": 0, "candidates": 0, "known_after": 0}
    monkeypatch.setitem(sys.modules, "harvester", fake)
    monkeypatch.setattr(db, "add_audit", lambda *a, **k: None)

    sweep.run_harvest(datetime.datetime(2026, 8, 1, 9, 0))
    assert order == ["expire", "harvest"]


def test_expiry_never_takes_the_sweep_down_with_it(testdb, monkeypatch):
    """A retired listing is housekeeping. The fleet's runs matter more, so a
    failure here is logged and stepped over."""
    monkeypatch.setattr(db, "expire_unseen_jobs",
                        lambda *_a: (_ for _ in ()).throw(RuntimeError("db down")))
    assert sweep.retire_stale_listings() == 0


def test_the_ttl_is_weeks_not_days_and_not_months(testdb):
    assert 14 <= sweep.LISTING_TTL_DAYS <= 45


def test_retirement_is_reversible(testdb):
    """Absence is a guess, not a fact. A posting that drops out of search for a
    month and comes back is open again, and must return to the pool."""
    old = _seed("old", days_ago=40)
    sweep.retire_stale_listings()
    assert db.get_job(old)["dead_at"] is not None

    db.upsert_job({"source": "atsboards", "external_id": "old", "title": "Intern",
                   "company": "Acme", "url": "https://acme.test/old", "skills": []})
    assert db.get_job(old)["dead_at"] is None
    assert old in {j["id"] for j in db.live_jobs()}
