"""One listing costs one fetch, however many users match it.

Reading a listing's description and deciding where its application goes are
facts about the LISTING. Neither varies by who is looking. They used to happen
inside each user's run, so a posting that matched 300 users was fetched 300
times — invisible in a one-user beta, and at a thousand users a thousand
identical requests to one employer, which is both wasteful and the fastest
possible way to get blocked by exactly the companies we want to reach.

The property under test is therefore not "the cache works" but "fleet cost does
not scale with user count".
"""
import os
import sqlite3
import time

import pytest

import db
import resolver
import worker

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "shared.db")
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


def _seed(ext="j1"):
    return db.upsert_job({
        "source": "atsboards", "external_id": ext, "title": "Backend Intern",
        "company": "Acme", "url": f"https://acme.test/{ext}", "skills": ["python"],
    })


# ── the description ───────────────────────────────────────────────────────

def test_a_listing_matched_by_many_users_is_fetched_once(testdb):
    job_id = _seed()
    fetches = {"n": 0}

    def fetch():
        fetches["n"] += 1
        return "We want a Python intern in Bengaluru."

    for _ in range(50):          # fifty users, same listing, same day
        job = {"url": "https://acme.test/j1"}   # a fresh dict per run, as in real life
        text, spent = worker.shared_jd(job, job_id, fetch)
        assert text == "We want a Python intern in Bengaluru."
        del spent

    assert fetches["n"] == 1, f"one listing cost {fetches['n']} fetches"


def test_a_cache_hit_is_not_charged_to_the_page_budget(testdb):
    """The budget exists to bound real traffic. Billing a cache hit shrinks it
    for every user after the first, so the fiftieth user gets a smaller run than
    the first for no reason."""
    job_id = _seed()
    _, first = worker.shared_jd({}, job_id, lambda: "a description")
    _, second = worker.shared_jd({}, job_id, lambda: "a description")
    assert first == 1
    assert second == 0


def test_a_fetch_that_comes_back_empty_is_not_stored_as_the_answer(testdb):
    """Otherwise one blocked request poisons the listing for the whole fleet."""
    job_id = _seed()
    worker.shared_jd({}, job_id, lambda: "")
    assert not db.get_job(job_id)["jd_text"]

    text, _ = worker.shared_jd({}, job_id, lambda: "the real description")
    assert text == "the real description"


def test_a_stale_description_is_refetched(testdb, monkeypatch):
    job_id = _seed()
    worker.shared_jd({}, job_id, lambda: "old text")
    with db.conn() as c:
        c.execute("UPDATE jobs SET jd_fetched_at=? WHERE id=?",
                  (db.time_ago_db(400 * 86400 * 1000), job_id))

    text, spent = worker.shared_jd({}, job_id, lambda: "fresh text")
    assert text == "fresh text"
    assert spent == 1


def test_a_listing_with_no_row_still_works(testdb):
    """Discovery can hand the apply loop a job it never persisted. That must
    degrade to the old per-run behaviour, not crash the run."""
    text, spent = worker.shared_jd({}, "", lambda: "some text")
    assert text == "some text"
    assert spent == 1


def test_a_database_failure_falls_back_to_fetching(testdb, monkeypatch):
    """The index is an optimisation. If it is unreadable the agent must still
    apply for people, just more expensively."""
    monkeypatch.setattr(db, "get_job", lambda _id: (_ for _ in ()).throw(RuntimeError("db down")))
    text, _ = worker.shared_jd({}, "some-id", lambda: "fetched anyway")
    assert text == "fetched anyway"


# ── the apply route ───────────────────────────────────────────────────────

def test_a_resolved_route_is_reused_across_users(testdb, monkeypatch):
    job_id = _seed()
    resolves = {"n": 0}

    def fake_resolve(job, jd_text, *, allow_fetch):
        resolves["n"] += 1
        return resolver.destination(
            channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
            target="https://acme.keka.com/careers/jobdetails/1", vendor="keka",
        ), 1

    monkeypatch.setattr(worker, "_resolve_destination", fake_resolve)

    for _ in range(30):
        dest, _loads = worker.shared_destination(
            {}, job_id, "jd", allow_fetch=True)
        assert dest["channel"] == resolver.CHANNEL_ATS
        assert dest["target"] == "https://acme.keka.com/careers/jobdetails/1"
        assert dest["vendor"] == "keka"

    assert resolves["n"] == 1, f"one listing resolved {resolves['n']} times"


def test_a_reused_route_costs_no_page_loads(testdb, monkeypatch):
    job_id = _seed()
    monkeypatch.setattr(worker, "_resolve_destination", lambda j, t, *, allow_fetch: (
        resolver.destination(channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
                             target="https://x.test/apply"), 2))
    _, first = worker.shared_destination({}, job_id, "jd", allow_fetch=True)
    _, second = worker.shared_destination({}, job_id, "jd", allow_fetch=True)
    assert first == 2
    assert second == 0


def test_a_found_nothing_verdict_is_never_cached(testdb, monkeypatch):
    """CHANNEL_PLATFORM means "we looked and found nothing better", and that is
    usually a product of the moment — the description had not been fetched yet,
    or the resolve budget had run out. Caching it would freeze a temporary blank
    into a permanent one for every user who ever matches this listing."""
    job_id = _seed()
    calls = {"n": 0}

    def sometimes(job, jd_text, *, allow_fetch):
        calls["n"] += 1
        if calls["n"] == 1:
            return resolver.platform_destination({"source": "atsboards"}, resolver.TIER_A), 0
        return resolver.destination(
            channel=resolver.CHANNEL_EMAIL, tier=resolver.TIER_A,
            target="careers@acme.test", vendor="email"), 1

    monkeypatch.setattr(worker, "_resolve_destination", sometimes)

    first, _ = worker.shared_destination({}, job_id, "", allow_fetch=False)
    assert first["channel"] == resolver.CHANNEL_PLATFORM
    assert db.get_job(job_id)["apply_channel"] is None

    second, _ = worker.shared_destination({}, job_id, "a real jd", allow_fetch=True)
    assert second["channel"] == resolver.CHANNEL_EMAIL


def test_a_stale_route_is_re_resolved(testdb, monkeypatch):
    job_id = _seed()
    db.set_job_route(job_id, resolver.CHANNEL_ATS, "https://old.test/apply", "A", "lever")
    with db.conn() as c:
        c.execute("UPDATE jobs SET resolved_at=? WHERE id=?",
                  (db.time_ago_db(400 * 86400 * 1000), job_id))

    monkeypatch.setattr(worker, "_resolve_destination", lambda j, t, *, allow_fetch: (
        resolver.destination(channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
                             target="https://new.test/apply", vendor="keka"), 1))
    dest, _ = worker.shared_destination({}, job_id, "jd", allow_fetch=True)
    assert dest["target"] == "https://new.test/apply"


def test_the_tier_survives_the_round_trip(testdb, monkeypatch):
    """Tier is what decides whether an unattended submit is allowed at all. A
    route that came back from the index as the wrong tier would either refuse a
    safe send or, far worse, permit an unsafe one."""
    job_id = _seed()
    monkeypatch.setattr(worker, "_resolve_destination", lambda j, t, *, allow_fetch: (
        resolver.destination(channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
                             target="https://x.test/apply", vendor="keka"), 0))
    worker.shared_destination({}, job_id, "jd", allow_fetch=True)

    monkeypatch.setattr(worker, "_resolve_destination", lambda j, t, *, allow_fetch: (
        _ for _ in ()).throw(AssertionError("should have used the stored route")))
    dest, _ = worker.shared_destination({}, job_id, "jd", allow_fetch=True)
    assert dest["tier"] == resolver.TIER_A


def test_a_route_write_failure_does_not_break_the_application(testdb, monkeypatch):
    monkeypatch.setattr(db, "set_job_route",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("db down")))
    monkeypatch.setattr(worker, "_resolve_destination", lambda j, t, *, allow_fetch: (
        resolver.destination(channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
                             target="https://x.test/apply"), 0))
    dest, _ = worker.shared_destination({}, _seed(), "jd", allow_fetch=True)
    assert dest["channel"] == resolver.CHANNEL_ATS
