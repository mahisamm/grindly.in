"""Email delivery from the agent side.

The contract that matters: `send()` returns True ONLY when a mail server actually
accepted the message.

It used to return True unconditionally — including when SMTP threw and it quietly
appended the mail to data/email-outbox.jsonl instead. Every caller therefore
believed every report had been delivered, `Notification.delivered` would have been
set to true for mail that reached nobody, and a totally broken SMTP config looked
identical to a working one from the inside. A delivery layer that cannot report
failure is not a delivery layer.

The outbox still exists, and is still written on failure — it is a useful dev
surface and a record of what we tried to send. It is no longer mistaken for
delivery.
"""
from __future__ import annotations

import json
import os
import smtplib
import ssl
import time
from email.mime.text import MIMEText

OUTBOX = os.path.join(os.path.dirname(__file__), "..", "data", "email-outbox.jsonl")

# Transient SMTP conditions worth a second attempt: greylisting, a rate limit, a
# connection reset mid-handshake. A rejected recipient or a bad password is not
# transient and retrying it just gets us rate-limited for real.
_RETRIES = 2
_RETRY_BACKOFF_SEC = 3


def configured() -> bool:
    """True if we have somewhere to actually send mail. Callers use this to warn
    the operator instead of silently dropping every user's report."""
    return bool(
        os.environ.get("EMAIL_SMTP_HOST")
        and os.environ.get("EMAIL_SMTP_USER")
        and os.environ.get("EMAIL_SMTP_PASS")
    )


def _outbox(to: str, subject: str, body: str, why: str) -> None:
    try:
        os.makedirs(os.path.dirname(OUTBOX), exist_ok=True)
        with open(OUTBOX, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "to": to, "subject": subject, "body": body, "undelivered": why,
            }) + "\n")
    except OSError as e:
        print(f"[email_notify] could not even write the outbox: {e}", flush=True)


def _deliver(to: str, subject: str, body: str) -> None:
    """One delivery attempt. Raises on any failure — the caller decides about retries."""
    host = os.environ["EMAIL_SMTP_HOST"]
    user = os.environ["EMAIL_SMTP_USER"]
    passwd = os.environ["EMAIL_SMTP_PASS"]
    sender = os.environ.get("EMAIL_FROM", f"Grindly <{user}>")
    port = int(os.environ.get("EMAIL_SMTP_PORT", "587"))

    msg = MIMEText(body, "plain", "utf-8")
    # Subject is passed through as-is. It used to be prefixed with "Grindly: ",
    # which produced "Grindly: Grindly daily report — 2026-07-14" for every caller
    # that (reasonably) already named the product in its own subject.
    msg["Subject"] = subject
    msg["From"] = sender
    msg["To"] = to

    ctx = ssl.create_default_context()
    # Port 465 is implicit TLS (SMTPS) — the connection is encrypted from the first
    # byte and STARTTLS is a protocol error there. 587 is plain with an explicit
    # STARTTLS upgrade.
    if port == 465:
        with smtplib.SMTP_SSL(host, port, context=ctx, timeout=20) as s:
            s.login(user, passwd)
            s.sendmail(sender, [to], msg.as_string())
    else:
        with smtplib.SMTP(host, port, timeout=20) as s:
            s.ehlo()
            s.starttls(context=ctx)
            s.login(user, passwd)
            s.sendmail(sender, [to], msg.as_string())


def send(to: str, subject: str, body: str) -> bool:
    """Send one email. True means a server accepted it. False means it did not
    arrive — and the caller must treat that as a real failure, not a formality."""
    if not to:
        return False

    if not configured():
        _outbox(to, subject, body, "no SMTP configured")
        print(f"[email_notify:stub] → {to}: {subject}", flush=True)
        return False

    last = ""
    for attempt in range(_RETRIES + 1):
        try:
            _deliver(to, subject, body)
            print(f"[email_notify] sent → {to}: {subject}", flush=True)
            return True
        except (smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused) as e:
            # Bad credentials or a bad address. Retrying changes nothing and only
            # gets the sending IP rate-limited for real.
            last = str(e)
            break
        except Exception as e:  # noqa: BLE001
            last = str(e)
            if attempt < _RETRIES:
                time.sleep(_RETRY_BACKOFF_SEC * (attempt + 1))

    print(f"[email_notify] SMTP failed after {_RETRIES + 1} attempt(s): {last}", flush=True)
    _outbox(to, subject, body, last[:300])
    return False
