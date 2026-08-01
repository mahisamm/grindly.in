"""The `jobs` table is ONE index shared by the whole fleet.

Discovery, description fetching and apply-route resolution are all true of the
LISTING, not of the user looking at it. They used to happen inside each user's
run, so the same posting was crawled, read and resolved again for every user it
matched — invisible at one user, and a thousand identical requests to one
employer at a thousand.

These tests hold the four properties that makes possible:

  1. a repeat sighting REFRESHES a listing instead of being ignored, so
     last_seen_at means something and edits are picked up;
  2. the expensive shared work (description, route) survives a re-sighting;
  3. a listing nobody has seen for weeks stops being offered;
  4. a listing is handed to at most K users, counted race-safely.
"""
import os
import sqlite3
import time

import pytest

import db

from test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "index.db")
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


def _job(ext="j1", **over):
    base = {"source": "atsboards", "external_id": ext, "title": "Intern",
            "company": "Acme", "url": f"https://acme.test/{ext}", "skills": ["python"]}
    base.update(over)
    return base


# ── 1. a re-sighting refreshes ────────────────────────────────────────────

def test_seeing_a_listing_again_moves_last_seen_at(testdb):
    """The bug this exists for: upsert_job returned early on a hit, so
    last_seen_at never moved and every listing looked equally stale. With no
    way to tell a posting that is still up from one that closed in April, the
    pool could only grow."""
    jid = db.upsert_job(_job())
    first = db.get_job(jid)["last_seen_at"]
    time.sleep(0.01)
    db.upsert_job(_job())
    assert db.get_job(jid)["last_seen_at"] > first


def test_an_edited_listing_is_updated_not_frozen_at_first_sighting(testdb):
    jid = db.upsert_job(_job(title="Intern", stipend="unpaid"))
    db.upsert_job(_job(title="Software Intern", stipend="15000/month"))
    row = db.get_job(jid)
    assert row["title"] == "Software Intern"
    assert row["stipend"] == "15000/month"


def test_upsert_is_still_idempotent_on_identity(testdb):
    assert db.upsert_job(_job()) == db.upsert_job(_job())


# ── 2. the expensive shared work survives ─────────────────────────────────

def test_a_re_sighting_does_not_throw_away_the_fetched_description(testdb):
    """jd_text and the apply route cost a page fetch each. A crawl re-finding
    the listing tomorrow must not blank them, or the shared index re-does its
    most expensive work every single day."""
    jid = db.upsert_job(_job())
    db.set_job_jd(jid, "We are looking for a Python intern.")
    db.set_job_route(jid, "ats", "https://acme.test/apply", "A", "keka")

    db.upsert_job(_job(title="Software Intern"))

    row = db.get_job(jid)
    assert row["jd_text"] == "We are looking for a Python intern."
    assert row["apply_channel"] == "ats"
    assert row["apply_tier"] == "A"
    assert row["apply_vendor"] == "keka"


def test_a_description_is_capped_so_one_page_cannot_bloat_the_index(testdb):
    jid = db.upsert_job(_job())
    db.set_job_jd(jid, "x" * 100_000)
    assert len(db.get_job(jid)["jd_text"]) == db._JD_MAX


def test_first_seen_is_preserved_while_last_seen_moves(testdb):
    """scraped_at means "first seen" and is what age is measured from; only
    last_seen_at tracks the most recent sighting."""
    jid = db.upsert_job(_job())
    first_scraped = db.get_job(jid)["scraped_at"]
    time.sleep(0.01)
    db.upsert_job(_job())
    assert db.get_job(jid)["scraped_at"] == first_scraped


# ── 3. dead listings stop being offered ───────────────────────────────────

def test_a_listing_nobody_has_seen_for_weeks_is_retired(testdb):
    jid = db.upsert_job(_job())
    # Backdate the sighting rather than waiting three weeks.
    with db.conn() as c:
        c.execute("UPDATE jobs SET last_seen_at=? WHERE id=?",
                  (db.time_ago_db(30 * 86400 * 1000), jid))

    assert db.expire_unseen_jobs(days=21) == 1
    assert db.get_job(jid)["dead_at"] is not None
    assert jid not in {j["id"] for j in db.live_jobs()}


def test_a_recently_seen_listing_survives_expiry(testdb):
    jid = db.upsert_job(_job())
    assert db.expire_unseen_jobs(days=21) == 0
    assert jid in {j["id"] for j in db.live_jobs()}


def test_finding_a_retired_listing_again_brings_it_back(testdb):
    """A posting that stops appearing in search for a month and then returns is
    live again. Marking it dead is a guess from absence, not a fact."""
    jid = db.upsert_job(_job())
    db.mark_job_dead(jid)
    assert db.get_job(jid)["dead_at"] is not None

    db.upsert_job(_job())
    assert db.get_job(jid)["dead_at"] is None


def test_a_dead_listing_is_kept_not_deleted(testdb):
    """Applications already sent reference it, and re-finding it is signal."""
    jid = db.upsert_job(_job())
    db.mark_job_dead(jid)
    assert db.get_job(jid) is not None


# ── 4. one listing goes to at most K users ────────────────────────────────

def test_a_listing_is_handed_to_at_most_k_users(testdb):
    """Without a cap, a shared pool means every matching user applies to the
    same employer on the same day: fifty near-identical applications from one
    product, and one listing burning the whole fleet's quota."""
    jid = db.upsert_job(_job())
    granted = sum(1 for _ in range(10) if db.claim_job_allocation(jid, k=3))
    assert granted == 3
    assert db.get_job(jid)["alloc_count"] == 3


def test_a_claim_and_its_count_are_one_statement(testdb):
    """Read-then-update is a lost-update race: two workers read alloc_count=2
    against a cap of 3 and both proceed. Asserted by construction — the claim
    must be refused the moment the cap is reached, with no read in between."""
    jid = db.upsert_job(_job())
    assert db.claim_job_allocation(jid, k=1) is True
    assert db.claim_job_allocation(jid, k=1) is False
    assert db.get_job(jid)["alloc_count"] == 1


def test_an_abandoned_application_returns_its_slot(testdb):
    """A slot is claimed BEFORE the send is attempted, so every path that gives
    up afterwards — missing fact, dead page, out of quota — has to give it back
    or the listing is permanently a slot short for everyone else."""
    jid = db.upsert_job(_job())
    assert db.claim_job_allocation(jid, k=1) is True
    db.release_job_allocation(jid)
    assert db.claim_job_allocation(jid, k=1) is True


def test_releasing_more_than_was_claimed_cannot_go_negative(testdb):
    jid = db.upsert_job(_job())
    db.release_job_allocation(jid)
    db.release_job_allocation(jid)
    assert db.get_job(jid)["alloc_count"] == 0


def test_a_dead_listing_cannot_be_claimed(testdb):
    jid = db.upsert_job(_job())
    db.mark_job_dead(jid)
    assert db.claim_job_allocation(jid, k=5) is False


def test_a_zero_cap_hands_the_listing_to_nobody(testdb):
    jid = db.upsert_job(_job())
    assert db.claim_job_allocation(jid, k=0) is False


# ── the readout the capacity maths depends on ─────────────────────────────

def test_index_stats_counts_live_described_and_routed_separately(testdb):
    a = db.upsert_job(_job("a"))
    b = db.upsert_job(_job("b"))
    db.upsert_job(_job("c"))
    db.set_job_jd(a, "a description")
    db.set_job_route(a, "ats", "https://acme.test/apply", "A")
    db.set_job_jd(b, "another description")
    db.mark_job_dead(b)

    s = db.index_stats()
    assert s["total"] == 3
    assert s["live"] == 2
    assert s["with_jd"] == 2
    assert s["routed"] == 1


def test_live_jobs_can_be_filtered_to_a_tier(testdb):
    a = db.upsert_job(_job("a"))
    b = db.upsert_job(_job("b"))
    db.set_job_route(a, "ats", "https://acme.test/apply", "A")
    db.set_job_route(b, "platform", None, "B")
    assert [j["id"] for j in db.live_jobs(tier="A")] == [a]
