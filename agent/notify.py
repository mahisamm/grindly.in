"""Notification delivery from the agent side.

`send()` is the raw Slack channel — mirrors the web adapter: writes to the same
data/slack-outbox.jsonl when no token, POSTs to Slack when SLACK_BOT_TOKEN is
set. Use it for OPS alerts, which always go to Slack.

`to_user()` is what user-facing messages should use: it honours the channel the
user actually picked (profile.report_channel), Email or Slack.
"""
from __future__ import annotations
import json
import os
import re
import time
import urllib.request

import email_notify

OUTBOX = os.path.join(os.path.dirname(__file__), "..", "data", "slack-outbox.jsonl")


def slack_configured() -> bool:
    return bool(os.environ.get("SLACK_BOT_TOKEN"))


def send(channel: str, text: str) -> bool:
    """Post to Slack. True means Slack accepted it.

    Returns FALSE when there is no token and the message went to the outbox file.
    That used to return True, which meant an unconfigured install reported every
    message as delivered — indistinguishable, from the inside, from one that
    worked. The outbox is a record of what we tried to send, not evidence that
    anyone received it.
    """
    token = os.environ.get("SLACK_BOT_TOKEN")
    if token:
        try:
            req = urllib.request.Request(
                "https://slack.com/api/chat.postMessage",
                data=json.dumps({"channel": channel, "text": text}).encode(),
                headers={
                    "Content-Type": "application/json; charset=utf-8",
                    "Authorization": f"Bearer {token}",
                },
            )
            with urllib.request.urlopen(req, timeout=20) as r:
                body = json.loads(r.read().decode())
            if not body.get("ok"):
                # Slack answers 200 with {"ok": false, "error": "channel_not_found"}
                # — the HTTP status tells you nothing.
                print(f"[notify] slack rejected the message: {body.get('error')}")
                return False
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[notify] slack post failed: {e}")
            return False

    try:
        os.makedirs(os.path.dirname(OUTBOX), exist_ok=True)
        with open(OUTBOX, "a", encoding="utf-8") as f:
            f.write(json.dumps({
                "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "channel": channel,
                "text": text,
                "undelivered": "no SLACK_BOT_TOKEN",
            }) + "\n")
    except OSError as e:
        print(f"[notify] could not write the outbox: {e}")
    print(f"[notify:stub] -> {channel}: {text[:80]}")
    return False


_SLACK_EMOJI = re.compile(r":[a-z0-9_+\-]+:")


def _plain(text: str) -> str:
    """Strip Slack mrkdwn so the same message reads correctly as an email."""
    t = _SLACK_EMOJI.sub("", text)
    t = re.sub(r"\*(.+?)\*", r"\1", t)          # *bold* -> bold
    t = re.sub(r"^[ \t]+", "", t, flags=re.M)   # leading space left by a dropped emoji
    return t.strip()


def _try(channel: str, dest: str, user: dict, subject: str, text: str) -> bool:
    """One delivery attempt, recorded. Every attempt lands in the notifications
    table with its TRUE outcome, so "why didn't I get my report?" is answerable
    from the database instead of by guessing."""
    if not dest:
        return False
    ok = (
        send(dest, text) if channel == "slack"
        else email_notify.send(dest, subject, _plain(text))
    )
    try:
        import db

        db.add_notification(
            user.get("id") or "", channel=channel, title=subject,
            body=_plain(text), delivered=ok,
        )
    except Exception as e:  # noqa: BLE001
        # Logging the attempt must never be the thing that breaks the run.
        print(f"[notify] could not record the notification: {e}")
    return ok


def to_user(user: dict, subject: str, text: str) -> bool:
    """Deliver a message on whichever channel the user actually chose.

    Every user-facing message used to go through send() — Slack, unconditionally.
    With SLACK_BOT_TOKEN unset in production that meant every daily report was
    appended to a JSONL file inside the container and read by nobody, including
    for the users who explicitly picked Email in onboarding.

    Channel comes from profile.report_channel ("email" | "slack"). If the chosen
    channel FAILS — not merely if it's unset — we try the other one, because a
    report the user never sees is the same as no agent at all.

    Returns False when the message reached nobody. Callers should treat that as a
    real failure; it is the signal that a production install is silently mute.
    """
    profile = user.get("profile") or {}
    chosen = (profile.get("report_channel") or "email").lower()
    dests = {
        "slack": user.get("slack_channel") or user.get("slack_user_id") or "",
        "email": user.get("email") or "",
    }

    order = ["slack", "email"] if chosen == "slack" else ["email", "slack"]
    for ch in order:
        if _try(ch, dests[ch], user, subject, text):
            if ch != chosen:
                print(f"[notify] {chosen} failed for {user.get('id')}; delivered via {ch}")
            return True

    print(
        f"[notify] UNDELIVERABLE for user {user.get('id')}: no channel worked "
        f"(slack_configured={slack_configured()}, smtp_configured={email_notify.configured()})"
    )
    return False
