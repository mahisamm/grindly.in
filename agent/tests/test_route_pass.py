"""Working out how to apply to a listing is fleet work, not user work.

A listing's apply route depends only on the posting, so the answer is identical
for every user. It was resolved lazily, on the first user to match — correct,
but with two costs that only appear at scale.

The first was measured, on production: capacity.py reported ZERO sendable
listings against a live pool of 298, because no route had ever been resolved. A
pool the agent does not know how to apply to is not capacity, however large it
looks.

The second is that the first user to match any listing paid for the fetch,
inside their own run, against their own page budget — for work that then
benefits everybody else.
"""
import os
import sqlite3
import time

import pytest

import db
import resolver
import sweep

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "routes.db")
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
    monkeypatch.setattr(db, "add_audit", lambda *a, **k: None)
    return path


def _seed(ext, url=None):
    return db.upsert_job({
        "source": "websource", "external_id": ext, "title": "Intern",
        "company": "Acme", "url": url or f"https://acme.test/{ext}", "skills": [],
    })


def _no_fetch(monkeypatch, jd=""):
    import websource
    monkeypatch.setattr(websource, "scrape_jd", lambda _url: jd)


def test_a_listing_on_an_ats_gets_its_route_without_any_user_running(testdb, monkeypatch):
    """The whole point: capacity should be real before the first user signs up,
    not after they have run for a week."""
    _no_fetch(monkeypatch)
    jid = _seed("j1", url="https://acme.keka.com/careers/jobdetails/44")

    out = sweep.resolve_routes()
    assert out["routed"] == 1

    row = db.get_job(jid)
    assert row["apply_channel"] == resolver.CHANNEL_ATS
    assert row["apply_tier"] == resolver.TIER_A
    assert row["apply_vendor"] == "keka"


def test_the_description_is_fetched_once_and_kept(testdb, monkeypatch):
    """The fetch is the expensive part, and it is exactly what the next user
    would otherwise have paid for inside their own run."""
    fetches = {"n": 0}

    import websource

    def counted(_url):
        fetches["n"] += 1
        return "Apply at careers@acme.test"

    monkeypatch.setattr(websource, "scrape_jd", counted)
    jid = _seed("j1")

    sweep.resolve_routes()
    assert fetches["n"] == 1
    assert db.get_job(jid)["jd_text"] == "Apply at careers@acme.test"

    # Second pass: already routed, so it is not even looked at again.
    sweep.resolve_routes()
    assert fetches["n"] == 1


def test_a_hiring_inbox_in_the_description_becomes_the_route(testdb, monkeypatch):
    _no_fetch(monkeypatch, jd="Send your CV to careers@acme.test")
    jid = _seed("j1")
    sweep.resolve_routes()
    row = db.get_job(jid)
    assert row["apply_channel"] == resolver.CHANNEL_EMAIL
    assert row["apply_target"] == "careers@acme.test"


def test_found_nothing_is_not_stored_as_an_answer(testdb, monkeypatch):
    """Same rule as worker.shared_destination: CHANNEL_PLATFORM means "we looked
    and found nothing better", which is usually a product of the moment. Stored,
    it would freeze a temporary blank into a permanent one — and, worse here,
    would make the listing look resolved so no later pass ever revisits it."""
    _no_fetch(monkeypatch, jd="A great internship. Apply now.")
    jid = _seed("j1")
    out = sweep.resolve_routes()
    assert out["no_route"] == 1
    assert db.get_job(jid)["apply_channel"] is None


def test_an_already_routed_listing_is_not_re_fetched(testdb, monkeypatch):
    import websource
    monkeypatch.setattr(websource, "scrape_jd",
                        lambda _u: pytest.fail("re-fetched an already-routed listing"))
    jid = _seed("j1")
    db.set_job_route(jid, resolver.CHANNEL_ATS, "https://acme.test/apply", "A", "keka")
    assert sweep.resolve_routes()["looked_at"] == 0


def test_a_retired_listing_is_not_worked_on(testdb, monkeypatch):
    _no_fetch(monkeypatch)
    jid = _seed("j1")
    db.mark_job_dead(jid)
    assert sweep.resolve_routes()["looked_at"] == 0


def test_the_pass_is_bounded_because_it_touches_real_employers(testdb, monkeypatch):
    """A politeness budget as much as a performance one. The backlog drains
    across days; a listing only ever needs resolving once."""
    _no_fetch(monkeypatch, jd="Send your CV to careers@acme.test")
    for i in range(25):
        _seed(f"j{i}")
    assert sweep.resolve_routes(limit=10)["looked_at"] == 10


def test_one_unreadable_listing_does_not_stop_the_pass(testdb, monkeypatch):
    import websource

    def flaky(url):
        if "bad" in url:
            raise RuntimeError("connection reset")
        return "Send your CV to careers@acme.test"

    monkeypatch.setattr(websource, "scrape_jd", flaky)
    _seed("bad", url="https://bad.test/x")
    good = _seed("good")

    out = sweep.resolve_routes()
    assert out["failed"] == 1
    assert out["routed"] == 1
    assert db.get_job(good)["apply_channel"] == resolver.CHANNEL_EMAIL


def test_a_pool_that_cannot_be_read_returns_zeroes_rather_than_raising(testdb, monkeypatch):
    monkeypatch.setattr(db, "live_jobs",
                        lambda **k: (_ for _ in ()).throw(RuntimeError("db down")))
    assert sweep.resolve_routes()["looked_at"] == 0


def test_the_route_pass_runs_after_the_harvest_not_before(testdb, monkeypatch):
    """The harvest has just added today's listings, and those are precisely the
    unrouted ones. Running the pass first would grind through yesterday's
    backlog and leave every new arrival for tomorrow."""
    import sys
    import types

    order = []
    monkeypatch.setattr(sweep, "retire_stale_listings", lambda *a, **k: None)
    monkeypatch.setattr(sweep, "resolve_routes", lambda *a, **k: order.append("routes") or {})
    monkeypatch.setattr(sweep, "harvest_due", lambda *a, **k: True)
    monkeypatch.setattr(sweep, "_last_harvest_date", "", raising=False)

    fake = types.ModuleType("harvester")
    fake.sweep = lambda: order.append("harvest") or {
        "learned": 0, "candidates": 0, "known_after": 0}
    monkeypatch.setitem(sys.modules, "harvester", fake)

    import datetime
    sweep.run_harvest(datetime.datetime(2026, 8, 1, 9, 0))
    assert order == ["harvest", "routes"]
