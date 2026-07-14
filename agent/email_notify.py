"""Simple email notification from the agent side.
Writes to data/email-outbox.jsonl (same file the Next.js adapter uses).
When EMAIL_SMTP_* vars are set, sends via SMTP directly.
"""
from __future__ import annotations
import json
import os
import smtplib
import ssl
import time
from email.mime.text import MIMEText

OUTBOX = os.path.join(os.path.dirname(__file__), "..", "data", "email-outbox.jsonl")


def send(to: str, subject: str, body: str) -> bool:
    host = os.environ.get("EMAIL_SMTP_HOST")
    user = os.environ.get("EMAIL_SMTP_USER")
    passwd = os.environ.get("EMAIL_SMTP_PASS")
    sender = os.environ.get("EMAIL_FROM", f"Grindly <{user or 'no-reply@grindly.local'}>")
    port = int(os.environ.get("EMAIL_SMTP_PORT", "587"))

    if host and user and passwd:
        try:
            msg = MIMEText(body, "plain", "utf-8")
            msg["Subject"] = f"Grindly: {subject}"
            msg["From"] = sender
            msg["To"] = to
            ctx = ssl.create_default_context()
            # Port 465 is implicit TLS (SMTPS) — the connection is encrypted from
            # the first byte and STARTTLS is a protocol error there. 587 is plain
            # with an explicit STARTTLS upgrade.
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
            print(f"[email_notify] sent → {to}: {subject}", flush=True)
            return True
        except Exception as e:
            print(f"[email_notify] SMTP failed: {e}", flush=True)

    # Fallback: write to outbox
    os.makedirs(os.path.dirname(OUTBOX), exist_ok=True)
    with open(OUTBOX, "a", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S"), "to": to, "subject": f"Grindly: {subject}", "body": body}) + "\n")
    print(f"[email_notify:stub] → {to}: {subject}", flush=True)
    return True
