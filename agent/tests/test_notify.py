"""Delivery has to be honest about failure.

Both channels used to return True when they had NOT delivered — Slack when there
was no token, email when SMTP threw — and both quietly appended the message to a
JSONL file instead. So a completely mute production install was indistinguishable,
from the inside, from a working one, and the `delivered` column would have recorded
"true" for mail that reached nobody.
"""
import smtplib
from unittest.mock import patch

import email_notify
import notify


USER = {
    "id": "u1",
    "email": "me@example.com",
    "slack_user_id": "U123",
    "profile": {"report_channel": "email"},
}


# --- the outbox is not delivery ---------------------------------------------

def test_email_without_smtp_reports_failure(monkeypatch, tmp_path):
    for k in ("EMAIL_SMTP_HOST", "EMAIL_SMTP_USER", "EMAIL_SMTP_PASS"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setattr(email_notify, "OUTBOX", str(tmp_path / "out.jsonl"))
    assert email_notify.send("me@example.com", "hi", "body") is False


def test_slack_without_a_token_reports_failure(monkeypatch, tmp_path):
    monkeypatch.delenv("SLACK_BOT_TOKEN", raising=False)
    monkeypatch.setattr(notify, "OUTBOX", str(tmp_path / "out.jsonl"))
    assert notify.send("U123", "hello") is False


def test_slack_reports_failure_when_slack_says_not_ok(monkeypatch):
    """Slack answers HTTP 200 with {"ok": false, "error": "channel_not_found"} —
    the status code alone tells you nothing."""
    monkeypatch.setenv("SLACK_BOT_TOKEN", "xoxb-test")

    class _R:
        def read(self): return b'{"ok": false, "error": "channel_not_found"}'
        def __enter__(self): return self
        def __exit__(self, *a): return False

    with patch.object(notify.urllib.request, "urlopen", return_value=_R()):
        assert notify.send("U123", "hello") is False


# --- SMTP behaviour ---------------------------------------------------------

def _smtp_env(monkeypatch):
    monkeypatch.setenv("EMAIL_SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("EMAIL_SMTP_USER", "u")
    monkeypatch.setenv("EMAIL_SMTP_PASS", "p")


def test_a_delivered_email_reports_success(monkeypatch):
    _smtp_env(monkeypatch)
    with patch.object(email_notify, "_deliver"):
        assert email_notify.send("me@example.com", "hi", "body") is True


def test_a_transient_smtp_error_is_retried(monkeypatch, tmp_path):
    _smtp_env(monkeypatch)
    monkeypatch.setattr(email_notify, "_RETRY_BACKOFF_SEC", 0)
    monkeypatch.setattr(email_notify, "OUTBOX", str(tmp_path / "out.jsonl"))
    calls = []

    def flaky(*a):
        calls.append(1)
        if len(calls) < 2:
            raise smtplib.SMTPServerDisconnected("greylisted")

    with patch.object(email_notify, "_deliver", side_effect=flaky):
        assert email_notify.send("me@example.com", "hi", "body") is True
    assert len(calls) == 2


def test_bad_credentials_are_not_retried(monkeypatch, tmp_path):
    """Retrying a rejected login changes nothing and gets the sending IP
    rate-limited for real."""
    _smtp_env(monkeypatch)
    monkeypatch.setattr(email_notify, "_RETRY_BACKOFF_SEC", 0)
    monkeypatch.setattr(email_notify, "OUTBOX", str(tmp_path / "out.jsonl"))
    calls = []

    def bad(*a):
        calls.append(1)
        raise smtplib.SMTPAuthenticationError(535, b"nope")

    with patch.object(email_notify, "_deliver", side_effect=bad):
        assert email_notify.send("me@example.com", "hi", "body") is False
    assert len(calls) == 1


def test_the_subject_is_not_double_prefixed(monkeypatch):
    """Callers already name the product; "Grindly: Grindly daily report — ..." was
    the result of prefixing it a second time."""
    _smtp_env(monkeypatch)
    seen = {}
    with patch.object(email_notify.smtplib, "SMTP") as smtp:
        smtp.return_value.__enter__.return_value.sendmail.side_effect = (
            lambda s, t, m: seen.update(msg=m)
        )
        email_notify.send("me@example.com", "Grindly daily report — 2026-07-14", "b")

    # The em-dash forces RFC 2047 encoding of the header, so read it back the way a
    # mail client would rather than substring-matching the raw wire format.
    import email as email_mod
    from email.header import decode_header, make_header

    subject = str(make_header(decode_header(
        email_mod.message_from_string(seen["msg"])["Subject"]
    )))
    assert subject == "Grindly daily report — 2026-07-14"


# --- routing ----------------------------------------------------------------

def test_the_chosen_channel_is_used_first():
    u = {**USER, "profile": {"report_channel": "slack"}}
    with patch.object(notify, "send", return_value=True) as slack, \
         patch.object(notify.email_notify, "send") as mail, \
         patch.object(notify, "_try", wraps=notify._try):
        assert notify.to_user(u, "s", "t") is True
    slack.assert_called_once()
    mail.assert_not_called()


def test_a_failing_channel_falls_back_to_the_other_one():
    """A report the user never sees is the same as no agent at all. If Slack is
    down, send the email — don't just drop it."""
    u = {**USER, "profile": {"report_channel": "slack"}}
    with patch.object(notify, "send", return_value=False), \
         patch.object(notify.email_notify, "send", return_value=True) as mail:
        assert notify.to_user(u, "s", "t") is True
    mail.assert_called_once()


def test_to_user_reports_failure_when_nothing_works():
    with patch.object(notify, "send", return_value=False), \
         patch.object(notify.email_notify, "send", return_value=False):
        assert notify.to_user(USER, "s", "t") is False


def test_every_attempt_is_recorded_with_its_true_outcome():
    """The delivered column existed from day one and nothing ever wrote it, so
    "did my user actually get their report?" was unanswerable."""
    recorded = []
    with patch.object(notify, "send", return_value=False), \
         patch.object(notify.email_notify, "send", return_value=False), \
         patch("db.add_notification", side_effect=lambda uid, **kw: recorded.append(kw)):
        notify.to_user(USER, "subject", "text")

    assert len(recorded) == 2                       # both channels were tried
    assert {r["channel"] for r in recorded} == {"email", "slack"}
    assert all(r["delivered"] is False for r in recorded)   # ...and neither lied


def test_slack_markup_is_stripped_from_the_email_version():
    sent = {}
    with patch.object(notify.email_notify, "send",
                      side_effect=lambda to, s, b: sent.update(body=b) or True), \
         patch("db.add_notification"):
        notify.to_user(USER, "s", ":robot_face: *Applied:* 3")
    assert ":robot_face:" not in sent["body"]
    assert "*" not in sent["body"]
    assert "Applied: 3" in sent["body"]
