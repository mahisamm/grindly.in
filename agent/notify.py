"""Slack notify from the agent side. Mirrors the web adapter: writes to the
same data/slack-outbox.jsonl when no token, POSTs to Slack when SLACK_BOT_TOKEN
is set. Same outbox the dashboard/onboarding reference."""
from __future__ import annotations
import json
import os
import time
import urllib.request

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
