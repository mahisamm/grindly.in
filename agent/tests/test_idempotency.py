"""The submission ledger — the thing that stops a duplicate application.

A queue message can be redelivered: a worker crash after the POST but before
the status write, a retry of an ambiguous timeout, a run reclaimed as stale.
Without a ledger the second attempt sends the SAME application to a real
employer under the user's name. That cannot be undone and reads to a recruiter
as spam, so every property here is about refusing the second send.
"""

import sqlite3
import threading
import time

import pytest

import db
import resolver
import worker


SCHEMA = """
CREATE TABLE submission_receipts (
    key TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT NOT NULL,
    detail TEXT, created_at INTEGER NOT NULL
);
"""


@pytest.fixture()
def ledger(tmp_path, monkeypatch):
    from contextlib import contextmanager

    path = str(tmp_path / "ledger.db")
    c = sqlite3.connect(path)
    c.executescript(SCHEMA)
    c.commit()
    c.close()

    @contextmanager
    def _conn():
        con = sqlite3.connect(path, timeout=15)
        con.row_factory = sqlite3.Row
        try:
            con.execute("PRAGMA busy_timeout = 8000")
            yield con
            con.commit()
        finally:
            con.close()

    monkeypatch.setattr(db, "PG", False)
    monkeypatch.setattr(db, "conn", _conn)
    monkeypatch.setattr(db, "now_db", lambda: int(time.time() * 1000))
    return path


# ---- the key identifies one (user, job, route) ------------------------------

def test_the_same_application_always_hashes_the_same():
    a = db.submission_key("u1", "https://x.com/job/1", "google_form", "https://form/1")
    b = db.submission_key("u1", "https://x.com/job/1", "google_form", "https://form/1")
    assert a == b


def test_url_case_and_spacing_do_not_create_a_second_identity():
    """A URL that differs only in case is the same application; treating it as
    new is how a duplicate slips through."""
    assert db.submission_key("u1", " https://X.com/Job/1 ", "email", "HR@x.com") == \
        db.submission_key("u1", "https://x.com/job/1", "email", "hr@x.com")


def test_different_users_never_share_a_key():
    assert db.submission_key("u1", "https://x/1", "email", "hr@x") != \
        db.submission_key("u2", "https://x/1", "email", "hr@x")


def test_the_same_job_by_a_different_route_is_a_different_send():
    """One listing can legitimately go out by a form today and a board later if
    routing changes — it must only be blocked from repeating the SAME route."""
    assert db.submission_key("u1", "https://x/1", "google_form", "f") != \
        db.submission_key("u1", "https://x/1", "email", "f")


# ---- claiming ---------------------------------------------------------------

def test_the_first_claim_wins_and_the_second_is_refused(ledger):
    key = db.submission_key("u1", "https://x/1", "email", "hr@x")
    assert db.claim_submission(key, "u1") is True
    assert db.claim_submission(key, "u1") is False


def test_concurrent_claimants_produce_exactly_one_winner(ledger):
    """Two workers replaying the same message must not both decide to send."""
    key = db.submission_key("u1", "https://x/1", "ats", "https://ats/1")
    wins, lock = [], threading.Lock()

    def go():
        ok = db.claim_submission(key, "u1")
        with lock:
            wins.append(ok)

    threads = [threading.Thread(target=go) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(wins) == 1, f"{sum(wins)} workers each thought they were first"


def test_a_released_claim_can_be_retried(ledger):
    """A definite non-send must not permanently block a real retry."""
    key = db.submission_key("u1", "https://x/1", "email", "hr@x")
    db.claim_submission(key, "u1")
    db.release_submission(key)
    assert db.claim_submission(key, "u1") is True


def test_an_unreachable_ledger_refuses_the_send(monkeypatch):
    """Fail CLOSED. If we cannot prove this is not a duplicate, not sending is
    the recoverable mistake; sending twice is not."""
    def broken():
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(db, "conn", broken)
    assert db.claim_submission("k", "u1") is False


# ---- dispatch honours the ledger -------------------------------------------

class _CountingChannel:
    def __init__(self, result=("applied", "sent"), submit_attempted=True):
        self.result, self.sends = result, 0
        # Real senders set record["submit_attempted"] at their point of no
        # return; the worker refunds a needs_review that arrives without it.
        self.submit_attempted = submit_attempted

    def apply(self, job, letter, uid, profile=None, resume_path=None,
              record=None, target="", skills=None):
        self.sends += 1
        if self.submit_attempted and record is not None:
            record["submit_attempted"] = True
        return self.result


def _dest(channel=resolver.CHANNEL_GOOGLE_FORM, target="https://form/1"):
    return resolver.destination(channel=channel, tier=resolver.TIER_A,
                                target=target, vendor="google", evidence="test")


def _job():
    return {"title": "Intern", "company": "Acme", "url": "https://x/1", "skills": []}


def test_a_replayed_message_does_not_send_twice(ledger, monkeypatch):
    """The failure this whole ledger exists to prevent."""
    ch = _CountingChannel()
    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, ch)

    args = dict(profile={}, resume_path=None, record={}, skills=[], source_modules={})
    first, _ = worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)
    second, why = worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)

    assert first == "applied"
    assert second == "skipped" and "twice" in why
    assert ch.sends == 1, "the employer must receive exactly one application"


def test_a_definite_failure_frees_the_key_for_a_real_retry(ledger, monkeypatch):
    ch = _CountingChannel(result=("failed", "network died"))
    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, ch)
    args = dict(profile={}, resume_path=None, record={}, skills=[], source_modules={})

    worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)
    ch.result = ("applied", "sent")
    status, _ = worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)
    assert status == "applied", "a genuine retry after a failure must be allowed"
    assert ch.sends == 2


def test_an_ambiguous_submit_keeps_its_claim(ledger, monkeypatch):
    """A needs_review AFTER the point of no return (submit_attempted set) means
    the submit LANDED and only its confirmation was unreadable. Retrying that
    is how a recruiter gets the same application twice, so the claim is
    deliberately not released."""
    ch = _CountingChannel(result=("needs_review", "submitted, no confirmation"))
    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, ch)
    args = dict(profile={}, resume_path=None, record={}, skills=[], source_modules={})

    worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)
    status, _ = worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)
    assert status == "skipped"
    assert ch.sends == 1


def test_a_pre_send_needs_review_frees_the_key(ledger, monkeypatch):
    """A needs_review BEFORE the point of no return — sender switched off, no
    resume file, unreadable form — provably sent nothing. Keeping the claim
    froze that listing on this channel forever: once the gap was fixed, the
    ledger still said 'already submitted' and the application never went out."""
    ch = _CountingChannel(
        result=("needs_review", "no resume file available"), submit_attempted=False,
    )
    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, ch)

    worker._dispatch_apply(_dest(), _job(), "letter", "u1",
                           profile={}, resume_path=None, record={}, skills=[],
                           source_modules={})
    ch.result, ch.submit_attempted = ("applied", "sent"), True
    status, _ = worker._dispatch_apply(_dest(), _job(), "letter", "u1",
                                       profile={}, resume_path=None, record={},
                                       skills=[], source_modules={})
    assert status == "applied", "fixing the gap must let the application send"
    assert ch.sends == 2


def test_a_sender_that_raises_keeps_its_claim(ledger, monkeypatch):
    """An exception proves nothing about whether the POST landed. Holding the
    claim risks a missed application; releasing it risks a duplicate."""
    class _Raiser:
        def apply(self, *a, **k):
            raise RuntimeError("connection reset mid-post")

    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, _Raiser())
    args = dict(profile={}, resume_path=None, record={}, skills=[], source_modules={})
    with pytest.raises(RuntimeError):
        worker._dispatch_apply(_dest(), _job(), "letter", "u1", **args)

    key = db.submission_key("u1", "https://x/1", resolver.CHANNEL_GOOGLE_FORM, "https://form/1")
    assert db.claim_submission(key, "u1") is False, "the claim must survive the crash"
