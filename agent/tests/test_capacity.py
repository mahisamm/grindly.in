"""Capacity is counted, not claimed.

"We promise 5 applications a day" is a statement about supply, and the failure
mode is silent: an agent serving 24 users out of a 300-listing pool looks
identical, from every dashboard, to one serving 2,400 — right up to the morning
the 25th user signs up and quietly starts getting two a day instead of five.
"""
import os
import sqlite3
import time

import pytest

import capacity
import db
import worker

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "cap.db")
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


def _seed(ext, routed=True, dead=False):
    jid = db.upsert_job({
        "source": "atsboards", "external_id": ext, "title": "Intern",
        "company": "Acme", "url": f"https://acme.test/{ext}", "skills": [],
    })
    db.set_job_jd(jid, "a description")
    if routed:
        db.set_job_route(jid, "ats", "https://acme.test/apply", "A", "keka")
    if dead:
        db.mark_job_dead(jid)
    return jid


def test_capacity_is_sendable_listings_times_k(testdb):
    for i in range(10):
        _seed(f"j{i}")
    r = capacity.report()
    assert r["employer_side"] == 10
    assert r["employer_sends_per_day"] == 10 * worker.ALLOC_PER_LISTING


def test_a_listing_with_no_route_is_not_counted_as_capacity(testdb):
    """The optimism this readout exists to remove. A listing nobody knows how to
    apply to cannot become an application however good the match is."""
    for i in range(5):
        _seed(f"routed{i}", routed=True)
    for i in range(20):
        _seed(f"unrouted{i}", routed=False)

    r = capacity.report()
    assert r["live"] == 25
    assert r["employer_side"] == 5
    assert r["employer_sends_per_day"] == 5 * worker.ALLOC_PER_LISTING


def test_users_supported_divides_by_the_plans_own_quota(testdb):
    for i in range(30):
        _seed(f"j{i}")
    r = capacity.report()
    sends = r["employer_sends_per_day"]
    assert r["users_supported_hands_off"]["plus"] == sends // 5
    assert r["users_supported_hands_off"]["pro"] == sends // 15


def test_a_pro_user_costs_three_times_a_plus_user(testdb):
    """Quoted per plan rather than averaged, because an average hides exactly
    this and the pro promise is the one most likely to break first."""
    for i in range(60):
        _seed(f"j{i}")
    r = capacity.report()
    assert r["users_supported_hands_off"]["plus"] == 3 * r["users_supported_hands_off"]["pro"]


def test_the_ceiling_shows_what_resolving_routes_would_buy(testdb):
    for i in range(5):
        _seed(f"routed{i}", routed=True)
    for i in range(45):
        _seed(f"unrouted{i}", routed=False)
    r = capacity.report()
    assert r["users_supported_hands_off"]["plus"] < r["if_all_live_were_routed"]["plus"]


def test_a_retired_listing_is_not_capacity(testdb):
    _seed("live1")
    _seed("dead1", dead=True)
    r = capacity.report()
    assert r["total"] == 2
    assert r["live"] == 1


def test_an_empty_index_reports_zero_rather_than_raising(testdb):
    r = capacity.report()
    assert r["employer_sends_per_day"] == 0
    assert r["users_supported_hands_off"]["plus"] == 0


def test_internshala_capacity_is_counted_but_kept_separate(testdb):
    """What the first version of this readout got wrong.

    It counted only employer-side routes and reported 52 users — while ignoring
    that 62% of the live pool is Internshala, which demonstrably sends and is
    the source of every confirmed application to date. But the two halves are
    not interchangeable, and adding them together would hide the thing that
    decides whether the product works: a user who never connects Internshala
    gets the employer-side number and nothing else.
    """
    for i in range(10):
        _seed(f"emp{i}", routed=True)
    for i in range(30):
        db.upsert_job({"source": "internshala", "external_id": f"is{i}",
                       "title": "Intern", "company": "Acme",
                       "url": f"https://internshala.com/i/{i}", "skills": []})

    r = capacity.report()
    assert r["employer_side"] == 10
    assert r["board"] == 30
    assert r["users_supported_hands_off"]["plus"] < r["users_supported_connected"]["plus"]


def test_a_user_who_connects_nothing_is_the_floor_that_is_reported_first(testdb):
    """A pool made entirely of board listings serves a hands-off user zero
    applications. If that ever reads as full capacity, the promise is broken
    and the readout is the only thing that would have said so."""
    for i in range(50):
        db.upsert_job({"source": "internshala", "external_id": f"is{i}",
                       "title": "Intern", "company": "Acme",
                       "url": f"https://internshala.com/i/{i}", "skills": []})
    r = capacity.report()
    assert r["users_supported_hands_off"]["plus"] == 0
    assert r["users_supported_connected"]["plus"] > 0


def test_a_retired_board_listing_is_not_counted_either(testdb):
    jid = db.upsert_job({"source": "internshala", "external_id": "is1",
                         "title": "Intern", "company": "Acme",
                         "url": "https://internshala.com/i/1", "skills": []})
    db.mark_job_dead(jid)
    assert capacity.report()["board"] == 0


def test_the_quotas_come_from_the_one_place_that_decides_them(testdb):
    """A second copy of these numbers is how a capacity report keeps quoting
    5/day confidently for a year after the plan became 8 — the exact silent
    wrongness this module exists to prevent."""
    assert capacity.PLAN_QUOTAS is db.PLAN_CAPS
