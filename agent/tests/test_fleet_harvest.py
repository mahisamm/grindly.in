"""The shared pool must fill whether or not anyone is logged in.

Board polling only ever happened inside a USER's run. So the index could not
grow unless somebody was already being served by it — and production, which has
no active user at all, would have left the 8,469 boards the tenant enumerator
just found completely unpolled.

That is backwards for a shared index. Which employers are hiring is not a fact
about any user; the listings land in one table everyone reads. A new user should
arrive to a full pool rather than spend their first week filling it for
everybody else.
"""
import os
import sqlite3
import time
import types

import pytest

import db
import sweep

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "fleet.db")
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


def _posting(i, jd="We want a Python intern in Bengaluru."):
    return {"external_id": f"e{i}", "title": "Software Intern", "company": f"Co{i}",
            "location": "Bengaluru", "stipend": "20000", "duration": "6 months",
            "skills": ["python"], "jd_text": jd,
            "url": f"https://co{i}.keka.com/careers/jobdetails/{i}"}


def _boards(monkeypatch, postings):
    fake = types.ModuleType("atsboards")
    fake.fetch = lambda keywords, limit=25, uid="": list(postings)
    monkeypatch.setitem(__import__("sys").modules, "atsboards", fake)
    return fake


def test_listings_reach_the_pool_with_no_user_involved(testdb, monkeypatch):
    """The whole point. Nobody is logged in; the pool fills anyway."""
    _boards(monkeypatch, [_posting(i) for i in range(5)])
    out = sweep.harvest_listings()
    assert out["stored"] == 5
    assert len(db.live_jobs()) == 5


def test_the_description_the_board_gave_us_is_kept(testdb, monkeypatch):
    """atsboards reads the description straight out of the vendor's JSON, so it
    costs nothing here. Dropping it made resolve_routes spend a real page fetch
    — against the employer's own server — re-fetching text we had already been
    handed a minute earlier, for every listing in every harvest."""
    _boards(monkeypatch, [_posting(1, jd="Python intern, Bengaluru, 6 months.")])
    out = sweep.harvest_listings()
    assert out["with_jd"] == 1
    assert db.live_jobs()[0]["jd_text"] == "Python intern, Bengaluru, 6 months."


def test_a_listing_the_board_gave_no_description_for_is_still_stored(testdb, monkeypatch):
    """Some vendors return a catalogue with no body text. That listing is still
    worth having — resolve_routes will fetch the description later."""
    _boards(monkeypatch, [_posting(1, jd="")])
    out = sweep.harvest_listings()
    assert out["stored"] == 1
    assert out["with_jd"] == 0


def test_the_same_listing_twice_is_one_row_with_a_fresh_sighting(testdb, monkeypatch):
    _boards(monkeypatch, [_posting(1)])
    sweep.harvest_listings()
    first = db.live_jobs()[0]["last_seen_at"]
    time.sleep(0.01)
    sweep.harvest_listings()
    rows = db.live_jobs()
    assert len(rows) == 1
    assert rows[0]["last_seen_at"] > first


def test_one_malformed_posting_does_not_cost_the_rest_of_the_harvest(testdb, monkeypatch):
    bad = {"title": None}          # no url, no external_id
    _boards(monkeypatch, [_posting(1), bad, _posting(2)])
    out = sweep.harvest_listings()
    assert out["stored"] >= 2


def test_a_board_source_that_explodes_does_not_take_the_sweep_down(testdb, monkeypatch):
    fake = types.ModuleType("atsboards")

    def boom(*a, **k):
        raise RuntimeError("every board timed out")

    fake.fetch = boom
    monkeypatch.setitem(__import__("sys").modules, "atsboards", fake)
    assert sweep.harvest_listings() == {"found": 0, "stored": 0, "with_jd": 0}


def test_the_keywords_are_broad_enough_not_to_bias_a_shared_pool(testdb):
    """These only RANK what atsboards._wanted() already decided was an India
    internship. A narrow list would quietly skew the pool everyone reads toward
    whichever domains the author happened to think of."""
    kw = {k.lower() for k in sweep.FLEET_KEYWORDS}
    for domain in ("software", "data", "design", "marketing", "finance", "research"):
        assert domain in kw, domain
    assert len(kw) >= 12


def test_the_harvest_order_is_boards_then_listings_then_routes(testdb, monkeypatch):
    """Each step feeds the next. Board harvest finds BOARDS; the listing harvest
    asks those boards what they are advertising; the route pass works out how to
    apply to what came back. Any other order does a day's work on yesterday's
    data."""
    import datetime
    import sys

    order = []
    monkeypatch.setattr(sweep, "retire_stale_listings", lambda *a, **k: None)
    monkeypatch.setattr(sweep, "harvest_listings", lambda *a, **k: order.append("listings") or {})
    monkeypatch.setattr(sweep, "resolve_routes", lambda *a, **k: order.append("routes") or {})
    monkeypatch.setattr(sweep, "harvest_due", lambda *a, **k: True)
    monkeypatch.setattr(sweep, "_last_harvest_date", "", raising=False)

    fake = types.ModuleType("harvester")
    fake.sweep = lambda: order.append("boards") or {
        "learned": 0, "candidates": 0, "known_after": 0}
    monkeypatch.setitem(sys.modules, "harvester", fake)

    sweep.run_harvest(datetime.datetime(2026, 8, 1, 9, 0))
    assert order == ["boards", "listings", "routes"]
