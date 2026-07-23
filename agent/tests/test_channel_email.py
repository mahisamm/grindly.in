"""Email channel — send the application from the user's own Gmail.

This channel mails from a real person's real address, so every refusal here is
protecting that address: no resume means it reads as spam, a read-only grant
means Google rejects it mid-flight, and an unresolved recipient means it goes
nowhere useful.
"""
import json

import channel_email as ce


def _profile():
    return {
        "name": "Asha Rao",
        "email": "asha@example.com",
        "phone": "9876543210",
    }


def _job():
    return {"title": "Backend Intern", "company": "Acme Robotics"}


# ── The switch ──────────────────────────────────────────────────────────────

def test_disabled_by_default(monkeypatch):
    monkeypatch.delenv("GMAIL_SEND_ENABLED", raising=False)
    assert ce.enabled() is False


def test_enabled_only_by_the_explicit_flag(monkeypatch):
    for junk in ("true", "yes", "0", ""):
        monkeypatch.setenv("GMAIL_SEND_ENABLED", junk)
        assert ce.enabled() is False
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    assert ce.enabled() is True


def test_a_disabled_deploy_holds_instead_of_failing(monkeypatch, tmp_path):
    monkeypatch.delenv("GMAIL_SEND_ENABLED", raising=False)
    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           target="careers@acme.in")
    assert status == "needs_review"
    assert "own inbox" in why


# ── Scope ───────────────────────────────────────────────────────────────────

def test_a_readonly_grant_cannot_send():
    grant = {"refresh_token": "t", "scope": "https://www.googleapis.com/auth/gmail.readonly"}
    assert ce.can_send(grant) is False


def test_a_grant_with_send_can_send():
    grant = {"refresh_token": "t", "scope": (
        "https://www.googleapis.com/auth/gmail.readonly "
        "https://www.googleapis.com/auth/gmail.send"
    )}
    assert ce.can_send(grant) is True


def test_a_legacy_grant_with_no_recorded_scope_is_treated_as_readonly():
    """Tokens minted before scopes were recorded must not be assumed capable —
    the failure mode of guessing wrong is a 403 in the middle of a job search."""
    assert ce.can_send({"refresh_token": "t", "scope": ""}) is False
    assert ce.can_send({"refresh_token": "t"}) is False
    assert ce.can_send(None) is False


def test_readonly_grant_asks_for_a_reconnect(monkeypatch):
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": "https://www.googleapis.com/auth/gmail.readonly",
    })
    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           target="careers@acme.in", resume_path=__file__)
    assert status == "login_required"
    assert "reconnect" in why.lower()


# ── Refusals ────────────────────────────────────────────────────────────────

def test_an_invalid_recipient_is_skipped(monkeypatch):
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    for target in ("", "not-an-email", "careers@", "@acme.in"):
        status, _ = ce.apply(_job(), "letter", "u1", profile=_profile(), target=target)
        assert status == "skipped"


def test_no_resume_means_no_send(monkeypatch):
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           target="careers@acme.in", resume_path=None)
    assert status == "needs_review"
    assert "resume" in why


def test_the_sender_is_the_connected_gmail_not_the_login_address(monkeypatch, tmp_path):
    """A student signs up with one address and connects a different Gmail all the
    time. Gmail will not send a message whose From is not the authenticated
    account, and an application claiming to come from an unreachable address is
    worse than one that doesn't go."""
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: "access-token")
    monkeypatch.setattr(ce, "gmail_address", lambda a, timeout=15: "asha.real@gmail.com")
    captured = {}
    monkeypatch.setattr(ce, "_send_raw", lambda a, raw, timeout=30: (
        captured.update({"raw": raw}) or (True, "msg-1")))

    status, why = ce.apply(
        _job(), "letter", "u1",
        profile={"name": "Asha Rao", "email": "signup-address@college.edu"},
        resume_path=str(resume), target="careers@acme.in",
    )
    assert status == "applied"
    decoded = __import__("base64").urlsafe_b64decode(captured["raw"]).decode("utf-8", "replace")
    assert "asha.real@gmail.com" in decoded
    assert "signup-address@college.edu" not in decoded.split("\n\n")[0]  # not in headers


def test_no_gmail_connection_asks_for_one(monkeypatch):
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: None)
    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           target="careers@acme.in", resume_path=__file__)
    assert status == "login_required"
    assert "not connected" in why


# ── The message itself ──────────────────────────────────────────────────────

def test_message_carries_the_resume_and_a_real_from_address(tmp_path):
    resume = tmp_path / "asha_resume.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    msg = ce.build_message(
        to="careers@acme.in", sender="asha@example.com", sender_name="Asha Rao",
        subject="Application: Backend Intern — Asha Rao",
        body="Hello", resume_path=str(resume),
    )
    assert msg["To"] == "careers@acme.in"
    assert msg["From"] == "Asha Rao <asha@example.com>"
    attachments = [p.get_filename() for p in msg.iter_attachments()]
    assert attachments == ["asha_resume.pdf"]


def test_body_contains_the_cover_letter_and_contact_details():
    body = ce._body(_job(), "I shipped a Django API.", _profile())
    assert "I shipped a Django API." in body
    assert "resume is attached" in body
    assert "9876543210" in body
    assert "Asha Rao" in body


def test_subject_names_the_role_and_the_candidate():
    assert ce._subject(_job(), "Asha Rao") == "Application: Backend Intern — Asha Rao"


# ── A successful send ───────────────────────────────────────────────────────

def test_a_successful_send_reports_applied(monkeypatch, tmp_path):
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: "access-token")
    captured = {}

    def fake_send(access, raw, timeout=30):
        captured["access"] = access
        captured["raw"] = raw
        return True, "msg-1"

    monkeypatch.setattr(ce, "_send_raw", fake_send)

    rec = {}
    status, why = ce.apply(_job(), "I shipped a Django API.", "u1",
                           profile=_profile(), resume_path=str(resume), record=rec,
                           target="careers@acme.in")
    assert status == "applied"
    assert "careers@acme.in" in why
    assert captured["access"] == "access-token"
    assert rec["destination"] == "careers@acme.in"
    assert json.loads(rec["answers"])


def test_a_403_is_reported_as_a_permission_problem_not_a_failure(monkeypatch, tmp_path):
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: "access-token")
    monkeypatch.setattr(ce, "_send_raw", lambda a, r, timeout=30: (False, "HTTP 403: insufficient"))

    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           resume_path=str(resume), target="careers@acme.in")
    assert status == "login_required"
    assert "send permission" in why


def test_a_rate_limit_or_outage_is_reported_as_temporary(monkeypatch, tmp_path):
    """429 and 5xx fix themselves. Filing them as a hard failure retired a real
    match over a problem that was going to clear on its own."""
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: "access-token")
    monkeypatch.setattr(ce, "gmail_address", lambda a, timeout=15: "asha@gmail.com")

    for code in (429, 500, 503):
        monkeypatch.setattr(ce, "_send_raw",
                            lambda a, r, timeout=30, c=code: (False, f"HTTP {c}: busy"))
        status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                               resume_path=str(resume), target="careers@acme.in")
        assert status == "failed"
        assert "temporarily" in why and "try this one again" in why


def test_a_403_inside_an_error_body_is_not_mistaken_for_a_scope_problem(monkeypatch, tmp_path):
    """Classification reads the status line, not the whole body — a Google error
    payload routinely mentions a number that used to trigger a false 'reconnect
    your Gmail'."""
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: "access-token")
    monkeypatch.setattr(ce, "gmail_address", lambda a, timeout=15: "asha@gmail.com")
    monkeypatch.setattr(ce, "_send_raw", lambda a, r, timeout=30: (
        False, "HTTP 400: Invalid to header (see error 403 in the docs)"))

    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           resume_path=str(resume), target="careers@acme.in")
    assert status == "failed"
    assert "reconnect" not in why.lower()


def test_a_failed_send_records_no_sent_to_line(monkeypatch, tmp_path):
    """A failed send used to still write "Sent to <recruiter>" into the
    application's answer record, which the dashboard shows as what went out."""
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: "access-token")
    monkeypatch.setattr(ce, "gmail_address", lambda a, timeout=15: "asha@gmail.com")
    monkeypatch.setattr(ce, "_send_raw", lambda a, r, timeout=30: (False, "HTTP 500: boom"))

    rec = {}
    ce.apply(_job(), "letter", "u1", profile=_profile(), resume_path=str(resume),
             record=rec, target="careers@acme.in")
    assert "answers" not in rec


def test_an_expired_grant_asks_for_a_reconnect(monkeypatch, tmp_path):
    resume = tmp_path / "r.pdf"
    resume.write_bytes(b"%PDF-1.4 fake")
    monkeypatch.setenv("GMAIL_SEND_ENABLED", "1")
    monkeypatch.setattr(ce, "gmail_grant", lambda uid: {
        "refresh_token": "t", "scope": ce.SEND_SCOPE,
    })
    monkeypatch.setattr(ce, "refresh_access_token", lambda t: None)

    status, why = ce.apply(_job(), "letter", "u1", profile=_profile(),
                           resume_path=str(resume), target="careers@acme.in")
    assert status == "login_required"
    assert "expired" in why
