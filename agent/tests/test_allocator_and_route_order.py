"""A shared pool needs an allocator, and the routes need an order.

Both are properties of the fleet rather than of any one run, which is why they
are easy to get wrong and invisible when you do.

The allocator: one index shared by everyone means that, uncapped, every user
whose skills match a posting is handed that posting the same day. The employer
receives fifty near-identical applications from one product at once — spam from
their side, a fast route to being blocked from ours, and one listing burning
fifty users' slots instead of one.

The route order: the agent must try the cheapest, most direct, fully unattended
route FIRST, and only fall back to something needing the user's own browser when
everything else has been refused. Reversed, every application waits on a
student's laptop being open, and the promise the product is sold on ("you do
nothing") quietly stops being true.
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
    path = str(tmp_path / "alloc.db")
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
        "source": "atsboards", "external_id": ext, "title": "Intern",
        "company": "Acme", "url": f"https://acme.test/{ext}", "skills": ["python"],
    })


# ── the cap ───────────────────────────────────────────────────────────────

def test_a_thousand_users_cannot_all_apply_to_one_listing(testdb):
    """The whole point. Simulated at fleet scale, because the failure only
    appears at fleet scale — at one user this looks perfect either way."""
    job_id = _seed()
    granted = sum(1 for _ in range(1000)
                  if db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING))
    assert granted == worker.ALLOC_PER_LISTING
    assert db.get_job(job_id)["alloc_count"] == worker.ALLOC_PER_LISTING


def test_the_default_cap_is_a_number_a_real_employer_would_not_notice(testdb):
    """Three applications for one internship is ordinary. One would waste most
    of the pool — a posting only ever suits a handful of the fleet anyway."""
    assert 2 <= worker.ALLOC_PER_LISTING <= 5


def test_each_listing_has_its_own_budget(testdb):
    a, b = _seed("a"), _seed("b")
    for _ in range(worker.ALLOC_PER_LISTING):
        assert db.claim_job_allocation(a, worker.ALLOC_PER_LISTING)
    assert db.claim_job_allocation(b, worker.ALLOC_PER_LISTING) is True


def test_capacity_is_pool_times_k(testdb):
    """The formula the whole supply effort multiplies against: fleet sends per
    day <= live listings x K. Asserted so a change to the allocator that
    silently breaks the arithmetic is caught here rather than in a capacity
    review three weeks later."""
    for i in range(20):
        _seed(f"j{i}")
    pool = len(db.live_jobs())
    sends = 0
    for job in db.live_jobs():
        while db.claim_job_allocation(job["id"], worker.ALLOC_PER_LISTING):
            sends += 1
    assert sends == pool * worker.ALLOC_PER_LISTING


# ── giving the slot back ──────────────────────────────────────────────────

def test_a_slot_is_returned_when_the_application_is_abandoned(testdb):
    """A slot is claimed BEFORE the send is attempted — it has to be, to be safe
    under concurrency. So every path that gives up afterwards has to return it,
    or the listing is permanently a slot short for everyone else."""
    job_id = _seed()
    for _ in range(worker.ALLOC_PER_LISTING):
        db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING)
    assert db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING) is False

    db.release_job_allocation(job_id)
    assert db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING) is True


def test_a_no_touch_fleet_does_not_consume_the_pool_while_sending_nothing(testdb):
    """no-touch drops any match the agent cannot finish alone. If those dropped
    matches kept their slots, a fleet in that mode would exhaust every listing's
    allocation and send zero applications."""
    job_id = _seed()
    for _ in range(50):
        if db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING):
            db.release_job_allocation(job_id)   # what the no-touch drop does
    assert db.get_job(job_id)["alloc_count"] == 0


def test_a_retired_listing_is_not_allocated(testdb):
    job_id = _seed()
    db.mark_job_dead(job_id)
    assert db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING) is False


def test_a_withdrawn_application_gives_its_slot_back_eventually(testdb):
    """The leak the in-run releases cannot catch.

    An application can disappear LONG after the run that created it — a board
    disconnected withdraws its still-pending matches, a deleted account
    cascades. Each leaks one slot on a live listing, permanently, and nothing
    reports it: the listing just becomes available to fewer people. So the count
    is derived from the applications that actually exist rather than trusted.
    """
    job_id = _seed()
    with db.conn() as c:
        c.execute("INSERT INTO users (id, email, plan, status, created_at) "
                  "VALUES (?,?,?,?,?)", ("u1", "u1@x.com", "free", "active", 0))
        c.execute("UPDATE jobs SET alloc_count=3 WHERE id=?", (job_id,))
        c.execute("INSERT INTO applications (id, user_id, job_id, job_title, "
                  "company, status, created_at) VALUES (?,?,?,?,?,?,?)",
                  ("a1", "u1", job_id, "Intern", "Acme", "matched", 0))

    assert db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING) is False
    assert db.reconcile_allocations() == 1
    assert db.get_job(job_id)["alloc_count"] == 1
    # Two of the three slots were never really used, and are now available.
    assert db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING) is True


def test_reconciling_does_not_disturb_a_count_that_is_already_right(testdb):
    job_id = _seed()
    db.claim_job_allocation(job_id, worker.ALLOC_PER_LISTING)
    with db.conn() as c:
        c.execute("INSERT INTO users (id, email, plan, status, created_at) "
                  "VALUES (?,?,?,?,?)", ("u1", "u1@x.com", "free", "active", 0))
        c.execute("INSERT INTO applications (id, user_id, job_id, job_title, "
                  "company, status, created_at) VALUES (?,?,?,?,?,?,?)",
                  ("a1", "u1", job_id, "Intern", "Acme", "applied", 0))
    assert db.reconcile_allocations() == 0
    assert db.get_job(job_id)["alloc_count"] == 1


def test_no_path_leaves_the_loop_holding_a_slot_it_never_used(testdb):
    """The leak this whole design is one careless `continue` away from.

    A slot is claimed before anything is attempted. Every way out of the apply
    loop after that point must therefore do ONE of two things: write an
    application row (the slot was genuinely used), or release the slot. A new
    early exit that does neither costs the fleet one allocation of that listing
    permanently, and nothing anywhere would report it — the listing just
    silently becomes available to fewer people, forever.

    Checked structurally, because that is the only way to catch the exit
    somebody adds next year.
    """
    import inspect
    lines = inspect.getsource(worker).splitlines()

    # Start AFTER the claim block, not at it. The `continue` inside that block
    # is the refusal — the slot was never granted, so there is nothing to give
    # back. `matched += 1` is the first line past which a slot is definitely
    # held.
    claim = next(i for i, ln in enumerate(lines) if "claim_job_allocation" in ln)
    start = next(i for i, ln in enumerate(lines[claim:], claim)
                 if ln.strip() == "matched += 1")

    # Bounded by INDENTATION, not by the next `def`. The apply loop sits inside
    # run_for_user, so the next `def` is hundreds of lines past the end of it —
    # and the first version of this test walked straight on into the per-source
    # drift loop that follows and reported its `continue` as a leak.
    body_indent = len(lines[start]) - len(lines[start].lstrip())
    end = len(lines)
    for i in range(start + 1, len(lines)):
        stripped = lines[i].strip()
        if not stripped or stripped.startswith("#"):
            continue
        if len(lines[i]) - len(lines[i].lstrip()) < body_indent:
            end = i
            break

    checked = 0
    for i in range(start + 1, end):
        if lines[i].strip() != "continue":
            continue
        checked += 1
        window = "\n".join(lines[max(start, i - 25):i])
        assert ("add_application" in window
                or "release_job_allocation" in window), (
            f"worker.py:{i + 1} leaves the apply loop after claiming an "
            "allocation without writing an application row or releasing the "
            "slot — that listing is now permanently one slot short for the "
            "whole fleet")

    # A scan that found no exits proves nothing. If the loop is ever
    # restructured so this walks an empty range, the test must fail loudly
    # rather than pass by vacuum.
    assert checked >= 3, (
        f"only {checked} loop exit(s) found after the allocation claim — this "
        "test is no longer looking at the apply loop")


# ── the route order ───────────────────────────────────────────────────────

def _dest(jd="", url="https://acme.test/listing", links=None):
    job = {"url": url, "source": "websource", "apply_links": links or []}
    return resolver.resolve(job, jd)


def test_the_employers_own_page_wins_over_everything(testdb):
    """The cheapest fully-unattended route: no account, no login, no user."""
    d = _dest(url="https://acme.keka.com/careers/jobdetails/9")
    assert d["channel"] == resolver.CHANNEL_ATS
    assert d["tier"] == resolver.TIER_A


def test_a_form_or_ats_named_in_the_description_beats_an_email(testdb):
    """A form submits itself. An inbox needs a sender we may not have."""
    jd = ("Apply at https://boards.greenhouse.io/acme/jobs/1 "
          "or write to careers@acme.test")
    assert _dest(jd)["channel"] == resolver.CHANNEL_ATS


def test_an_email_is_used_only_when_no_form_exists(testdb):
    assert _dest("Send your CV to careers@acme.test")["channel"] == resolver.CHANNEL_EMAIL


def test_the_board_is_the_last_resort_not_the_first(testdb):
    """A listing with no employer-side route falls back to the board it was
    found on — and only then. Reversed, every application would go through an
    account the user cannot afford to lose, when the employer's own open form
    was sitting there."""
    d = _dest("A great internship. Apply now.")
    assert d["channel"] == resolver.CHANNEL_PLATFORM


def test_the_users_own_browser_is_reached_for_last(testdb):
    """The extension is a FALLBACK, queued after a server send was held or
    refused — never a first choice. If it were tried first every application
    would wait on a student's laptop being open, and "you do nothing" would
    stop being true. Asserted structurally: the queueing calls all sit on
    paths that have already failed to send."""
    import inspect
    src = inspect.getsource(worker)
    queue_at = [i for i, line in enumerate(src.splitlines())
                if "_queue_browser_task(" in line and "def " not in line]
    assert queue_at, "the browser fallback disappeared"
    lines = src.splitlines()
    for i in queue_at:
        window = "\n".join(lines[max(0, i - 30):i]).lower()
        assert any(w in window for w in
                   ("needs_review", "held", "refused", "not auto_ok", "provably_not_sent")), (
            f"a browser task is queued at line {i} without a prior send having "
            "been held or refused — the extension must be the last route, not "
            "the first")
