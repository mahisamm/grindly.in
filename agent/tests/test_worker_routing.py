"""Worker-side routing — the dispatch that decides which code touches a form.

The unit under test is the seam: an application resolved to an employer channel
must go to that channel with its resolved target, and one resolved to a board
must go to the board adapter with the board's own retry rules. Getting that
backwards would either mail a Google Form URL or click Submit on LinkedIn — the
two failure modes this whole design exists to prevent.
"""
import urllib.request

import pytest

import resolver
import worker


@pytest.fixture(autouse=True)
def submission_ledger(monkeypatch):
    """In-memory stand-in for the idempotency ledger (db.submission_receipts).

    Dispatch claims a key before letting any sender run, and the real claim
    fails CLOSED when the database is unreachable — correct in production (an
    unprovable duplicate must not be sent) but it would make every routing test
    here read "skipped". These tests are about which module gets called, so the
    ledger is stubbed to a dict; test_idempotency.py covers the ledger itself.
    """
    claimed: set[str] = set()

    def claim(key, uid):
        if key in claimed:
            return False
        claimed.add(key)
        return True

    monkeypatch.setattr(worker.db, "claim_submission", claim)
    monkeypatch.setattr(worker.db, "record_submission", lambda *a, **k: None)
    monkeypatch.setattr(worker.db, "release_submission", lambda key: claimed.discard(key))
    return claimed


class _FakePlatform:
    """Stands in for internshala.py / linkedin.py / ..."""

    def __init__(self, results):
        self.results = list(results)
        self.calls = []

    def apply(self, job, letter, uid, profile=None, resume_path=None, record=None):
        self.calls.append({"job": job, "letter": letter, "uid": uid})
        return self.results.pop(0)


class _FakeChannel:
    def __init__(self, result=("applied", "sent")):
        self.result = result
        self.calls = []

    def apply(self, job, letter, uid, profile=None, resume_path=None,
              record=None, target="", skills=None):
        self.calls.append({"target": target, "skills": skills, "uid": uid})
        return self.result


def _dest(channel, target="https://docs.google.com/forms/d/e/X/viewform"):
    return resolver.destination(
        channel=channel, tier=resolver.TIER_A, target=target,
        vendor="google", evidence="test",
    )


def _job():
    return {"title": "Backend Intern", "company": "Acme", "url": "https://board/x",
            "source": "internshala", "skills": []}


# ── Dispatch ────────────────────────────────────────────────────────────────

def test_an_employer_channel_receives_the_resolved_target(monkeypatch):
    channel = _FakeChannel()
    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, channel)

    status, why = worker._dispatch_apply(
        _dest(resolver.CHANNEL_GOOGLE_FORM), _job(), "letter", "u1",
        profile={}, resume_path=None, record={}, skills=["Python"],
        source_modules={},
    )
    assert status == "applied"
    assert channel.calls[0]["target"].endswith("/viewform")
    assert channel.calls[0]["skills"] == ["Python"]


def test_an_employer_channel_does_not_need_a_connected_platform(monkeypatch):
    """The whole point: a Google Form submit must not depend on a board session."""
    channel = _FakeChannel()
    monkeypatch.setitem(worker._CHANNEL_MODULES, resolver.CHANNEL_GOOGLE_FORM, channel)

    status, _ = worker._dispatch_apply(
        _dest(resolver.CHANNEL_GOOGLE_FORM), _job(), "letter", "u1",
        profile={}, resume_path=None, record={}, skills=[],
        source_modules={},   # nothing connected
    )
    assert status == "applied"


def test_a_board_destination_goes_to_the_platform_adapter():
    platform = _FakePlatform([("applied", "submitted")])
    status, _ = worker._dispatch_apply(
        _dest(resolver.CHANNEL_PLATFORM, ""), _job(), "letter", "u1",
        profile={}, resume_path=None, record={}, skills=[],
        source_modules={"internshala": platform},
    )
    assert status == "applied"
    assert len(platform.calls) == 1


def test_an_undeliverable_channel_never_falls_back_to_the_board():
    """The bug this locks down: _CHANNEL_MODULES has no "ats" entry, and the dict
    miss used to fall straight through to the board adapter — so a listing routed
    AWAY from LinkedIn got submitted ON LinkedIn. Inverts the whole design."""
    platform = _FakePlatform([("applied", "submitted")])
    ats = resolver.destination(
        channel=resolver.CHANNEL_ATS, tier=resolver.TIER_A,
        target="https://jobs.lever.co/acme/abc", vendor="lever", evidence="test",
    )
    status, why = worker._dispatch_apply(
        ats, _job(), "letter", "u1", profile={}, resume_path=None, record={},
        skills=[], source_modules={"internshala": platform},
    )
    assert status == "needs_review"
    assert platform.calls == []          # the board was never touched
    assert "automatically" in why or "yourself" in why


def test_channel_deliverable_separates_permitted_from_possible(monkeypatch):
    def d(channel, target="x"):
        return resolver.destination(channel=channel, tier=resolver.TIER_A, target=target)

    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setenv("GRINDLY_ATS_APPLY", "1")
    assert worker.channel_deliverable(d(resolver.CHANNEL_GOOGLE_FORM)) is True
    assert worker.channel_deliverable(d(resolver.CHANNEL_EMAIL)) is True
    assert worker.channel_deliverable(d(resolver.CHANNEL_ATS)) is True
    assert worker.channel_deliverable(d(resolver.CHANNEL_PLATFORM, "")) is True
    # An employer channel with no resolved target is not deliverable either.
    assert worker.channel_deliverable(d(resolver.CHANNEL_GOOGLE_FORM, "")) is False
    assert worker.channel_deliverable(None) is False


def test_a_switched_off_sender_is_not_deliverable(monkeypatch):
    """"Built" and "switched on" are different facts. Calling a disabled sender
    deliverable spends one of the user's daily quota slots on a dispatch that
    can only come back as needs_review."""
    def d(channel):
        return resolver.destination(channel=channel, tier=resolver.TIER_A, target="x")

    monkeypatch.delenv("GMAIL_SEND_ENABLED", raising=False)
    monkeypatch.delenv("GRINDLY_ATS_APPLY", raising=False)
    assert worker.channel_deliverable(d(resolver.CHANNEL_EMAIL)) is False
    assert worker.channel_deliverable(d(resolver.CHANNEL_ATS)) is False
    # Google Form posts directly and has no switch, so it stays deliverable.
    assert worker.channel_deliverable(d(resolver.CHANNEL_GOOGLE_FORM)) is True


def test_a_missing_platform_module_is_skipped_not_faked():
    status, why = worker._dispatch_apply(
        _dest(resolver.CHANNEL_PLATFORM, ""), _job(), "letter", "u1",
        profile={}, resume_path=None, record={}, skills=[],
        source_modules={},
    )
    assert status == "skipped"
    assert "unavailable" in why


def test_a_selector_failure_is_retried_once(monkeypatch):
    monkeypatch.setattr(worker.time, "sleep", lambda s: None)
    platform = _FakePlatform([
        ("failed", "apply button selector not found"),
        ("applied", "submitted"),
    ])
    status, _ = worker._dispatch_apply(
        _dest(resolver.CHANNEL_PLATFORM, ""), _job(), "letter", "u1",
        profile={}, resume_path=None, record={}, skills=[],
        source_modules={"internshala": platform},
    )
    assert status == "applied"
    assert len(platform.calls) == 2


def test_a_timeout_is_never_retried(monkeypatch):
    """A timeout can fire AFTER the submit landed — retrying files a second real
    application under the user's name."""
    monkeypatch.setattr(worker.time, "sleep", lambda s: None)
    platform = _FakePlatform([("failed", "timeout waiting for element")])
    status, _ = worker._dispatch_apply(
        _dest(resolver.CHANNEL_PLATFORM, ""), _job(), "letter", "u1",
        profile={}, resume_path=None, record={}, skills=[],
        source_modules={"internshala": platform},
    )
    assert status == "failed"
    assert len(platform.calls) == 1


# ── Resolution wrapper ──────────────────────────────────────────────────────

def test_resolution_failure_degrades_to_the_board(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("resolver exploded")

    monkeypatch.setattr(worker.resolver, "resolve", boom)
    dest, loads = worker._resolve_destination(_job(), "jd", allow_fetch=False)
    assert dest["channel"] == resolver.CHANNEL_PLATFORM
    assert dest["tier"] == resolver.TIER_B   # internshala
    assert loads == 0


def test_no_fetcher_is_passed_when_fetching_is_disallowed(monkeypatch):
    seen = {}

    def spy(job, jd_text, fetch=None, max_follow=2):
        seen["fetch"] = fetch
        return resolver.platform_destination(job, resolver.TIER_C)

    monkeypatch.setattr(worker.resolver, "resolve", spy)
    worker._resolve_destination(_job(), "Apply on the company website", allow_fetch=False)
    assert seen["fetch"] is None


def test_a_fetcher_is_passed_only_when_the_jd_points_off_platform(monkeypatch):
    seen = {}

    def spy(job, jd_text, fetch=None, max_follow=2):
        seen["fetch"] = fetch
        return resolver.platform_destination(job, resolver.TIER_C)

    monkeypatch.setattr(worker.resolver, "resolve", spy)

    worker._resolve_destination(_job(), "A plain description.", allow_fetch=True)
    assert seen["fetch"] is None

    worker._resolve_destination(_job(), "Apply on the company website.", allow_fetch=True)
    assert callable(seen["fetch"])


def test_only_real_page_loads_are_charged_to_the_fetch_budget(monkeypatch):
    """Routing a listing from its JD text alone costs nothing. Charging the
    budget for it would starve the runs that genuinely need to follow a link."""
    monkeypatch.setattr(worker, "_fetch_public_html", lambda url, timeout=20: "")

    # Resolved from the JD text — no fetch, no charge.
    job = {"url": "https://internshala.com/x", "source": "internshala"}
    _, loads = worker._resolve_destination(
        job, "Apply here: https://forms.gle/AbCd1234", allow_fetch=True,
    )
    assert loads == 0

    # Has to follow a careers link — charged per page actually loaded.
    _, loads = worker._resolve_destination(
        job, "Apply on the company website: https://acme.in/careers", allow_fetch=True,
    )
    assert loads == 1


class _Resp:
    def __init__(self, ctype, body=b"<html>ok</html>", final_url="https://acme.in/careers"):
        self.headers = {"Content-Type": ctype}
        self._body = body
        self._final_url = final_url

    def geturl(self):
        return self._final_url

    def read(self, n=None):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_public_html_fetch_rejects_non_html_bodies(monkeypatch):
    """A careers page is being read for an apply link. A PDF or a binary is not
    that, and decoding one just to regex it is wasted work."""
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: _Resp("application/pdf", b"%PDF"))
    assert worker._fetch_public_html("https://acme.in/careers") == ""


def test_public_html_fetch_returns_html_bodies(monkeypatch):
    monkeypatch.setattr(urllib.request, "urlopen",
                        lambda *a, **k: _Resp("text/html; charset=utf-8"))
    assert worker._fetch_public_html("https://acme.in/careers") == "<html>ok</html>"


def test_public_html_fetch_swallows_network_errors(monkeypatch):
    """A dead careers page must cost the run nothing — resolution degrades to the
    board rather than aborting a user's whole sweep."""
    def boom(*a, **k):
        raise OSError("dns fail")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    assert worker._fetch_public_html("https://acme.in/careers") == ""


def test_public_html_fetch_refuses_an_internal_url_without_a_request(monkeypatch):
    """SSRF guard at the fetch site: the URL comes from a job description, which
    anyone who can post a listing controls."""
    def must_not_be_called(*a, **k):
        raise AssertionError("must not issue a request to an internal address")

    monkeypatch.setattr(urllib.request, "urlopen", must_not_be_called)
    for url in ("http://169.254.169.254/latest/meta-data/", "http://web:3000/api/admin",
                "http://127.0.0.1:5432/", "file:///etc/passwd"):
        assert worker._fetch_public_html(url) == ""


def test_public_html_fetch_refuses_a_redirect_into_the_private_network(monkeypatch):
    """A public host can 302 to an internal one, so checking only the URL we asked
    for would be checking the wrong thing."""
    monkeypatch.setattr(urllib.request, "urlopen", lambda *a, **k: _Resp(
        "text/html", b"<html>secret</html>", final_url="http://169.254.169.254/latest/meta-data/",
    ))
    assert worker._fetch_public_html("https://acme.in/careers") == ""
