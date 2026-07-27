"""Email application channel — send the application from the user's own Gmail.

Why this channel is the safest one we have
------------------------------------------
Everything else in the agent acts *as* the user against a site that would rather
we didn't. This does the opposite: it uses Google's documented `gmail.send`
scope, with a token the user granted on a Google consent screen, to send a mail
from their own address. There is no account to ban, no session to keep alive, no
bot detection to survive, and the recruiter receives a normal email from a real
person — which is also why it outperforms a board application on reply rate.

The cost is that `gmail.send` is a restricted scope: the Google Cloud project
must clear verification before it can serve users outside its test list. That is
the same wall `gmail.readonly` already sits behind (see src/lib/googleOAuth.ts),
so this channel stays dark until that clears — and fails closed, loudly, rather
than silently doing nothing, when it is not available.

What it will not do
-------------------
It will not send without an attached resume, and it will not send to a free-mail
address (`resolver` already refuses those — a gmail.com "HR" box is the classic
fake-internship pattern). It writes nothing into the mail that the resume does
not support: the body is the same cover letter the rest of the pipeline already
generated and the user can read back on the application row.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import urllib.error
import urllib.request
from email.message import EmailMessage

import db
import secret_box
from email_scanner import refresh_access_token

_SEND_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_PROFILE_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/profile"

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")


def enabled() -> bool:
    """Email apply is off unless the deploy says the Gmail project can send.

    Separate from GMAIL_SCAN_ENABLED on purpose: reading a user's inbox and
    sending mail as them are different grants and different verification states.
    """
    return os.environ.get("GMAIL_SEND_ENABLED") == "1"


SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


def gmail_grant(uid: str) -> dict | None:
    """The user's stored Gmail grant: {refresh_token, scope}, or None.

    Written by src/app/api/auth/gmail/callback (PlatformCredential, platform
    "gmail"), encrypted with the shared AES-256-GCM box.
    """
    blob = db.get_platform_credential(uid, "gmail")
    if not blob:
        return None
    try:
        payload = json.loads(secret_box.decrypt_secret(blob))
    except Exception:  # noqa: BLE001
        return None
    tok = payload.get("refresh_token")
    if not isinstance(tok, str) or not tok:
        return None
    return {"refresh_token": tok, "scope": payload.get("scope") or ""}


def gmail_refresh_token(uid: str) -> str | None:
    """Just the refresh token, for callers that don't care about scope."""
    grant = gmail_grant(uid)
    return grant["refresh_token"] if grant else None


def can_send(grant: dict | None) -> bool:
    """Was this grant minted with send permission?

    A grant stored before gmail.send was switched on carries only readonly, and
    Google answers a send with a 403. Checking the recorded scope turns that into
    a clear "reconnect Gmail" before anything is attempted. An empty scope string
    means a token from before scopes were recorded at all — treated as *not*
    send-capable, because assuming otherwise fails in the one place it must not.
    """
    if not grant:
        return False
    return SEND_SCOPE in (grant.get("scope") or "")


_STATUS_RE = re.compile(r"^HTTP (\d{3}):")


def _status_code(detail: str) -> int | None:
    """The HTTP status from a _send_raw failure string, or None if it wasn't one."""
    m = _STATUS_RE.match(detail or "")
    return int(m.group(1)) if m else None


def build_message(
    *,
    to: str,
    sender: str,
    sender_name: str,
    subject: str,
    body: str,
    resume_path: str | None,
) -> EmailMessage:
    msg = EmailMessage()
    msg["To"] = to
    msg["From"] = f"{sender_name} <{sender}>" if sender_name else sender
    msg["Subject"] = subject
    msg.set_content(body)

    if resume_path and os.path.isfile(resume_path):
        ctype, _ = mimetypes.guess_type(resume_path)
        maintype, _, subtype = (ctype or "application/pdf").partition("/")
        with open(resume_path, "rb") as fh:
            msg.add_attachment(
                fh.read(),
                maintype=maintype,
                subtype=subtype or "pdf",
                filename=os.path.basename(resume_path),
            )
    return msg


def _subject(job: dict, name: str) -> str:
    title = (job.get("title") or "Internship").strip()
    who = f" — {name}" if name else ""
    return f"Application: {title}{who}"


def _body(job: dict, cover_letter: str, profile: dict) -> str:
    """The mail a recruiter actually reads. The cover letter is the substance;
    the contact block below it exists because an HR mailbox reply goes to a
    person, not to a dashboard."""
    name = (profile.get("name") or "").strip()
    phone = (profile.get("phone") or "").strip()
    email = (profile.get("email") or "").strip()

    lines = [cover_letter.strip(), ""]
    lines.append("My resume is attached.")
    lines.append("")
    if name:
        lines.append(name)
    contact = " | ".join(x for x in (phone, email) if x)
    if contact:
        lines.append(contact)
    return "\n".join(lines)


def gmail_address(access_token: str, timeout: int = 15) -> str | None:
    """The address of the Gmail account this token actually belongs to.

    The sender cannot be taken from the Grindly profile. A student very often
    signs up with one address and connects a different Gmail, and Gmail will not
    send a message whose From is not the authenticated account — it either
    rewrites it or rejects the send. Worse, the application would claim to come
    from an address the recruiter cannot reply to.

    So ask Google who this token is, and use that.
    """
    req = urllib.request.Request(
        _PROFILE_ENDPOINT, headers={"Authorization": f"Bearer {access_token}"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            addr = (json.loads(r.read().decode() or "{}") or {}).get("emailAddress")
            return addr if isinstance(addr, str) and _EMAIL_RE.match(addr) else None
    except Exception:  # noqa: BLE001
        return None


def _send_raw(access_token: str, raw_b64: str, timeout: int = 30) -> tuple[bool, str]:
    req = urllib.request.Request(
        _SEND_ENDPOINT,
        data=json.dumps({"raw": raw_b64}).encode(),
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = json.loads(r.read().decode() or "{}")
            return True, payload.get("id") or "sent"
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:200]
        return False, f"HTTP {e.code}: {detail}"
    except Exception as e:  # noqa: BLE001
        return False, str(e)[:200]


def apply(
    job: dict,
    cover_letter: str,
    uid: str = "",
    profile: dict | None = None,
    resume_path: str | None = None,
    record: dict | None = None,
    *,
    target: str = "",
    skills: list[str] | None = None,
) -> tuple[str, str]:
    """Email the application from the user's Gmail. Same (status, reason)
    contract as every platform adapter.

    status ∈ {applied, skipped, failed, needs_review, login_required}
    """
    del skills  # the cover letter is already grounded in the resume
    profile = profile or {}
    record = record if record is not None else {}

    to = (target or "").strip()
    if not _EMAIL_RE.match(to):
        return "skipped", "no valid employer email resolved"

    if not enabled():
        return "needs_review", (
            "Email apply is not switched on for this deployment yet — "
            "send this one from your own inbox."
        )

    # An application email without a resume is not an application. Refuse rather
    # than send something that reads as spam from the user's real address.
    if not (resume_path and os.path.isfile(resume_path)):
        return "needs_review", "no resume file available to attach"

    grant = gmail_grant(uid)
    if not grant:
        return "login_required", "Gmail is not connected — connect it in the dashboard"
    if not can_send(grant):
        return "login_required", (
            "Gmail is connected for reading only — reconnect it to let the agent "
            "send applications from your address"
        )

    access = refresh_access_token(grant["refresh_token"])
    if not access:
        return "login_required", "Gmail authorisation expired — reconnect it in the dashboard"

    # Who this token actually belongs to — NOT profile.email. Signing up with one
    # address and connecting a different Gmail is normal, and a From that is not
    # the authenticated account gets rewritten or rejected by Google. Falling back
    # to no From at all is correct: Gmail then fills in the account's own address,
    # which is the one thing guaranteed to be right.
    sender = gmail_address(access) or ""
    if sender and profile.get("email") and sender.lower() != str(profile["email"]).lower():
        log_note = f"sending from the connected Gmail ({sender}), not the login address"
    else:
        log_note = ""

    msg = build_message(
        to=to,
        sender=sender,
        sender_name=(profile.get("name") or "").strip(),
        subject=_subject(job, (profile.get("name") or "").strip()),
        body=_body(job, cover_letter, profile),
        resume_path=resume_path,
    )
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()

    # Point of no return: past here the message may exist in the user's Sent
    # mail even when the API response is unreadable. The worker refunds the
    # daily slot and idempotency claim for a needs_review WITHOUT this flag.
    record["submit_attempted"] = True
    ok, detail = _send_raw(access, raw)
    record["destination"] = to

    if ok:
        # The Q&A record is written ONLY on success. Recording "Sent to <address>"
        # after a failed send put a line in the user's application history saying
        # something went out that never did.
        record["answers"] = json.dumps([
            {"q": "Application email subject", "a": msg["Subject"], "source": "profile"},
            {"q": "Sent from", "a": sender or "your Gmail", "source": "profile"},
            {"q": "Sent to", "a": to, "source": "profile"},
        ])
        note = f" — {log_note}" if log_note else ""
        return "applied", f"emailed to {to} from your Gmail (message {detail}){note}"

    # Classify on the STATUS LINE, not by substring-searching the whole body: a
    # Google error payload routinely contains "403" or "401" inside an unrelated
    # message, and matching that told users to reconnect a Gmail that was fine.
    status_code = _status_code(detail)
    if status_code == 401 or "invalid_grant" in detail.lower():
        return "login_required", "Gmail authorisation rejected — reconnect it in the dashboard"
    if status_code == 403:
        # Almost always the scope: the stored token predates gmail.send, so the
        # user has to re-consent. Say that instead of "failed".
        return "login_required", (
            "Gmail has not granted send permission — reconnect Gmail to allow sending"
        )
    if status_code == 429 or (status_code is not None and 500 <= status_code < 600):
        # Rate limit or a Google outage. Temporary, and the application must stay
        # sendable — reporting it as a hard failure retired a real match over a
        # problem that fixes itself.
        return "failed", (
            f"Gmail was temporarily unavailable (HTTP {status_code}) — "
            f"the agent will try this one again"
        )
    return "failed", f"could not send the application email: {detail}"
