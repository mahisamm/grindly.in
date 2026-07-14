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


def send(channel: str, text: str) -> bool:
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
                return json.loads(r.read().decode()).get("ok", False)
        except Exception as e:  # noqa: BLE001
            print(f"[notify] slack post failed: {e}")
            return False

    os.makedirs(os.path.dirname(OUTBOX), exist_ok=True)
    with open(OUTBOX, "a", encoding="utf-8") as f:
        f.write(json.dumps({
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "channel": channel,
            "text": text,
        }) + "\n")
    print(f"[notify:stub] -> {channel}: {text[:80]}")
    return True


_SLACK_EMOJI = re.compile(r":[a-z0-9_+\-]+:")


def _plain(text: str) -> str:
    """Strip Slack mrkdwn so the same message reads correctly as an email."""
    t = _SLACK_EMOJI.sub("", text)
    t = re.sub(r"\*(.+?)\*", r"\1", t)          # *bold* -> bold
    t = re.sub(r"^[ \t]+", "", t, flags=re.M)   # leading space left by a dropped emoji
    return t.strip()


def to_user(user: dict, subject: str, text: str) -> bool:
    """Deliver a message on whichever channel the user actually chose.

    Every user-facing message used to go through send() — Slack, unconditionally.
    With SLACK_BOT_TOKEN unset in production that meant every daily report was
    appended to a JSONL file inside the container and read by nobody, including
    for the users who explicitly picked Email in onboarding.

    Channel comes from profile.report_channel ("email" | "slack"); we fall back
    to whichever channel is actually reachable rather than dropping the message.
    """
    profile = user.get("profile") or {}
    channel = (profile.get("report_channel") or "email").lower()
    slack_dest = user.get("slack_channel") or user.get("slack_user_id")
    email_dest = user.get("email")

    if channel == "slack" and slack_dest:
        return send(slack_dest, text)
    if email_dest:
        return email_notify.send(email_dest, subject, _plain(text))
    if slack_dest:
        return send(slack_dest, text)

    print(f"[notify] no reachable channel for user {user.get('id')}")
    return False
