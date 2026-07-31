"""A backlog nobody will ever send is not a stocked pipeline.

`pipeline_depth` throttles discovery: a run should not re-scrape the boards when
there is already a queue of work. In no-touch mode the question it was asking
was the wrong one — it counted rows on the table rather than work the AGENT can
finish — and in that mode discovery is the only thing that sends, because a
match the agent can deliver is dispatched inline the moment it is found and
never banked.

One live account reached 43 banked rows: 25 behind a dead Internshala session,
17 on boards that are never submitted from a server. That sat permanently above
the refill threshold, so the agent searched nothing and sent nothing, every day,
while every switch in the system read "on".
"""
import os
import sqlite3
import time

import pytest

import db
from tests.test_db import SCHEMA, _real_conn


@pytest.fixture()
def testdb(tmp_path, monkeypatch):
    path = str(tmp_path / "pipeline.db")
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


def _row(uid, *, status="matched", tier=None, failure=None, company="Acme"):
    db.add_application(
        uid, job_id=None, title="Intern", company=company, url="https://x/1",
        score=80, status=status, reason="ok", applied=False,
        failure_reason=failure,
        destination={"channel": "platform", "tier": tier, "target": ""} if tier else None,
    )


def test_every_banked_match_still_counts_by_default(testdb):
    for _ in range(4):
        _row("u1", tier="C")
    assert db.pipeline_depth("u1") == 4


def test_a_row_the_agent_can_never_send_is_not_pipeline(testdb):
    # Tier C is never submitted from our servers at any setting, so it can never
    # be the reason the agent decides it already has enough to do.
    for _ in range(4):
        _row("u1", tier="C")
    assert db.pipeline_depth("u1", deliverable_only=True) == 0


def test_a_row_that_already_failed_is_a_blockage_not_a_backlog(testdb):
    _row("u1", tier="B", failure="session_expired")
    _row("u1", tier="B", failure="session_expired")
    assert db.pipeline_depth("u1", deliverable_only=True) == 0


def test_real_work_still_counts(testdb):
    _row("u1", tier="A")
    _row("u1", tier="B")
    assert db.pipeline_depth("u1", deliverable_only=True) == 2


def test_the_live_deadlock_unblocks(testdb):
    # The exact shape of the stuck account: 25 Tier B behind a dead session, 17
    # Tier C, one live Tier A. Refill threshold is 35.
    for _ in range(25):
        _row("u1", tier="B", failure="session_expired")
    for _ in range(17):
        _row("u1", tier="C")
    _row("u1", tier="A")
    assert db.pipeline_depth("u1") == 43                       # what it used to see
    assert db.pipeline_depth("u1", deliverable_only=True) == 1  # what is actually left


def test_only_matched_rows_count_in_either_mode(testdb):
    _row("u1", status="applied", tier="A")
    _row("u1", status="skipped", tier="A")
    _row("u1", status="needs_review", tier="A")
    assert db.pipeline_depth("u1") == 0
    assert db.pipeline_depth("u1", deliverable_only=True) == 0


def test_one_users_backlog_does_not_throttle_another(testdb):
    for _ in range(5):
        _row("u1", tier="A")
    assert db.pipeline_depth("u2", deliverable_only=True) == 0


def test_a_row_with_no_recorded_destination_still_counts(testdb):
    # Legacy rows predate destination routing. Treating an unknown tier as
    # undeliverable would make the agent re-scrape on every run for accounts
    # whose queue is simply old.
    _row("u1", tier=None)
    assert db.pipeline_depth("u1", deliverable_only=True) == 1
