"""
Gmail email scanner — reads the user's inbox to detect interview/offer/rejection
emails from companies they applied to, updates Application.outcome in DB, and
fires a Slack/email notification.

Usage (called by /api/gmail/scan):
    python agent/email_scanner.py <path_to_tokens_json>

Tokens JSON: { "userId": "...", "refresh_token": "..." }

Requirements: google-auth google-auth-httplib2 google-api-python-client
    pip install google-auth google-auth-httplib2 google-api-python-client
"""
from __future__ import annotations
import json
import os
import re
import sys
import time
import base64
import urllib.request
import urllib.parse

from db import _load_dotenv, get_conn, cuid

_load_dotenv()

# ── Token refresh ──────────────────────────────────────────────────────────────

def refresh_access_token(refresh_token: str) -> str | None:
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    if not client_id or not client_secret:
        print("[email_scanner] GOOGLE_CLIENT_ID/SECRET not set", flush=True)
        return None
    try:
        body = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh_token,
            "grant_type": "refresh_token",
        }).encode()
        req = urllib.request.Request(
            "https://oauth2.googleapis.com/token",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode())
            return data.get("access_token")
    except Exception as e:
        print(f"[email_scanner] token refresh failed: {e}", flush=True)
        return None


# ── Gmail API helpers ──────────────────────────────────────────────────────────

def gmail_get(path: str, access_token: str) -> dict:
    url = f"https://gmail.googleapis.com/gmail/v1/users/me{path}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {access_token}"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode())


def list_messages(access_token: str, query: str, max_results: int = 50) -> list[dict]:
    params = urllib.parse.urlencode({"q": query, "maxResults": max_results})
    data = gmail_get(f"/messages?{params}", access_token)
    return data.get("messages", [])


def get_message(msg_id: str, access_token: str) -> dict:
    return gmail_get(f"/messages/{msg_id}?format=full", access_token)


def extract_body(payload: dict) -> str:
    """Recursively pull plaintext body from MIME parts."""
    def _parts(p: dict) -> str:
        mime = p.get("mimeType", "")
        body_data = p.get("body", {}).get("data", "")
        if mime == "text/plain" and body_data:
            try:
                return base64.urlsafe_b64decode(body_data + "==").decode("utf-8", errors="ignore")
            except Exception:
                return ""
        for part in p.get("parts", []):
            text = _parts(part)
            if text:
                return text
        return ""
    return _parts(payload)


def extract_headers(payload: dict) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


# ── LLM classification ─────────────────────────────────────────────────────────

CLASSIFY_PROMPT = """You are classifying a recruitment email.

Company: {company}
Job title: {title}
Email subject: {subject}
Email body (first 800 chars): {body}

Classify this email into exactly ONE of these outcomes:
- interview  (invited for interview, screening call, HR call, technical round)
- offer      (job offer extended)
- rejected   (application declined, not moving forward)
- test       (coding test, assignment, assessment link sent)
- no_response (automated acknowledgement / no action needed)
- unrelated  (not related to this application)

Reply with ONLY a JSON object: {{"outcome": "<one of the above>", "confidence": 0.0-1.0, "note": "<one line reason>"}}"""


def classify_email(company: str, title: str, subject: str, body: str) -> dict:
    from llm import chat_json
    prompt = CLASSIFY_PROMPT.format(
        company=company,
        title=title,
        subject=subject,
        body=body[:800],
    )
    result = chat_json(prompt)
    if result and "outcome" in result:
        return result
    # Keyword fallback if LLM unavailable
    text = f"{subject} {body}".lower()
    if any(w in text for w in ["interview", "schedule", "screening", "round", "hr call"]):
        return {"outcome": "interview", "confidence": 0.7, "note": "keyword match"}
    if any(w in text for w in ["offer", "congratulation", "pleased to offer", "joining"]):
        return {"outcome": "offer", "confidence": 0.7, "note": "keyword match"}
    if any(w in text for w in ["regret", "unfortunately", "not moving forward", "not selected", "rejected"]):
        return {"outcome": "rejected", "confidence": 0.7, "note": "keyword match"}
    if any(w in text for w in ["assessment", "coding test", "assignment", "hackerrank", "codility"]):
        return {"outcome": "test", "confidence": 0.7, "note": "keyword match"}
    return {"outcome": "no_response", "confidence": 0.3, "note": "no signal"}


# ── Notification ───────────────────────────────────────────────────────────────

OUTCOME_EMOJI = {
    "interview": "🎉",
    "offer": "🏆",
    "rejected": "😔",
    "test": "📝",
}

def notify_user(user_id: str, company: str, title: str, outcome: str, note: str) -> None:
    conn = get_conn()
    try:
        user = conn.execute(
            "SELECT email, slack_user_id, slack_connected FROM users WHERE id = ?",
            (user_id,)
        ).fetchone()
        if not user:
            return

        emoji = OUTCOME_EMOJI.get(outcome, "📧")
        msg_title = f"{emoji} {outcome.title()} — {company}"
        msg_body = f"*{title}* at *{company}*\n{note}\n\nSee your dashboard for details."

        if user["slack_connected"] and user["slack_user_id"]:
            from notify import send as slack_send
            slack_send(user["slack_user_id"], f"*{msg_title}*\n{msg_body}")
            print(f"[email_scanner] Slack notified: {user['slack_user_id']}", flush=True)
        else:
            # Email fallback — write to outbox
            import email_notify
            email_notify.send(user["email"], msg_title, msg_body)
            print(f"[email_scanner] Email queued: {user['email']}", flush=True)
    finally:
        conn.close()


# ── Email notify fallback (simple SMTP or outbox) ─────────────────────────────

def _ensure_email_notify():
    """Create agent/email_notify.py if missing — keeps email_scanner self-contained."""
    pass


# ── Main scan ─────────────────────────────────────────────────────────────────

def scan(user_id: str, refresh_token: str) -> dict:
    access_token = refresh_access_token(refresh_token)
    if not access_token:
        return {"scanned": 0, "detected": [], "error": "token_refresh_failed"}

    conn = get_conn()
    # Fetch applied applications for this user (last 90 days)
    since_ms = int((time.time() - 90 * 86400) * 1000)
    apps = conn.execute(
        """SELECT id, job_title, company FROM applications
           WHERE user_id = ? AND status = 'applied' AND created_at > ?
           ORDER BY created_at DESC LIMIT 200""",
        (user_id, since_ms)
    ).fetchall()
    conn.close()

    if not apps:
        return {"scanned": 0, "detected": [], "error": None}

    # Build search query: emails from company domains we applied to
    # Gmail query: newer_than:90d category:primary
    query = "newer_than:90d category:primary"
    messages = list_messages(access_token, query, max_results=100)

    scanned = 0
    detected = []

    for msg_meta in messages:
        try:
            msg = get_message(msg_meta["id"], access_token)
            headers = extract_headers(msg.get("payload", {}))
            sender = headers.get("from", "")
            subject = headers.get("subject", "")
            body = extract_body(msg.get("payload", {}))
            scanned += 1

            # Match sender to any applied company
            matched_app = None
            sender_lower = sender.lower()
            for app in apps:
                company_slug = re.sub(r"[^a-z0-9]", "", app["company"].lower())
                if company_slug and company_slug in sender_lower:
                    matched_app = app
                    break
                # Also match by subject containing company name
                if app["company"].lower() in subject.lower():
                    matched_app = app
                    break

            if not matched_app:
                continue

            result = classify_email(matched_app["company"], matched_app["job_title"], subject, body)
            outcome = result.get("outcome", "no_response")
            confidence = result.get("confidence", 0.0)

            if outcome in ("no_response", "unrelated") or confidence < 0.5:
                continue

            # Update application outcome in DB
            conn2 = get_conn()
            existing = conn2.execute(
                "SELECT outcome FROM applications WHERE id = ?", (matched_app["id"],)
            ).fetchone()
            if not existing or not existing["outcome"]:
                conn2.execute(
                    "UPDATE applications SET outcome = ?, outcome_at = ? WHERE id = ?",
                    (outcome, int(time.time() * 1000), matched_app["id"])
                )
                conn2.commit()
                conn2.close()

                notify_user(user_id, matched_app["company"], matched_app["job_title"], outcome, result.get("note", ""))
                detected.append({
                    "appId": matched_app["id"],
                    "company": matched_app["company"],
                    "outcome": outcome,
                    "subject": subject,
                })
                print(f"[email_scanner] Detected: {outcome} — {matched_app['company']} ({subject[:60]})", flush=True)
            else:
                conn2.close()

        except Exception as e:
            print(f"[email_scanner] Error processing message: {e}", flush=True)
            continue

    result = {"scanned": scanned, "detected": detected, "error": None}
    print(json.dumps(result), flush=True)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: email_scanner.py <tokens_json_path>"}))
        sys.exit(1)

    with open(sys.argv[1], encoding="utf-8") as f:
        payload = json.load(f)

    scan(payload["userId"], payload["refresh_token"])
