"""Redact direct personal identifiers before text crosses the trust boundary.

Grindly's LLM ensemble runs on third-party providers (Groq, Gemini, Cerebras,
Mistral). Matching a resume and drafting a cover letter needs the candidate's
*skills and experience* — it never needs their email, phone, or government IDs.
So we scrub those identifiers from every prompt before it leaves our servers:
a leak, log, or training-set capture on the provider side then can't expose a
user's contact details or ID numbers.

This is the single egress choke point — `llm._build_messages` runs every
outbound prompt through `redact_messages`. On by default; a fully local /
self-hosted deployment that trusts its model host can disable it with
GRINDLY_REDACT_PII=0.

Deliberately conservative: only high-precision identifiers (emails, phone
numbers, long government-ID digit runs) are removed, so skill extraction and
job matching see the resume otherwise intact. Names are left in place — they
carry low standalone risk and a cover letter needs a salutation — but no
reliable-enough name detector exists to redact them without mangling ordinary
resume prose, so we don't guess.
"""
from __future__ import annotations

import os
import re

EMAIL_PLACEHOLDER = "[email redacted]"
PHONE_PLACEHOLDER = "[phone redacted]"
ID_PLACEHOLDER = "[id redacted]"

# name@host.tld — the "+" and dotted local parts real resumes use.
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")

# A run that looks like a phone number: an optional country code then 8+ more
# "phone-ish" characters. We validate the DIGIT COUNT (10-13) after matching so
# date ranges ("2020-2024" = 8 digits), GPAs, pincodes (6), and years never
# trip it. \+? keeps a leading +91 / 00 in the captured span.
_PHONE_RE = re.compile(r"(?<![\w@.])(\+?\d[\d\s().\-]{8,}\d)(?![\w])")

# 14+ consecutive digits: card-like / long government-ID runs that aren't phone
# numbers. Aadhaar (12) is already inside the phone window above.
_LONG_ID_RE = re.compile(r"(?<!\d)\d{14,}(?!\d)")

_DISABLED_VALUES = {"0", "false", "no", "off", ""}


def _enabled() -> bool:
    return os.environ.get("GRINDLY_REDACT_PII", "1").strip().lower() not in _DISABLED_VALUES


def _sub_phone(match: re.Match) -> str:
    span = match.group(1)
    digits = sum(ch.isdigit() for ch in span)
    # Only spans with a real phone-length digit count are numbers; anything
    # else (spaced-out dates, ranges) is left exactly as written.
    return PHONE_PLACEHOLDER if 10 <= digits <= 13 else span


def redact_pii(text: str) -> str:
    """Return `text` with emails, phone numbers, and long ID runs masked.

    Idempotent and safe on any input; returns the input unchanged when
    redaction is disabled or the value isn't a non-empty string.
    """
    if not text or not isinstance(text, str) or not _enabled():
        return text
    out = _EMAIL_RE.sub(EMAIL_PLACEHOLDER, text)
    out = _PHONE_RE.sub(_sub_phone, out)
    out = _LONG_ID_RE.sub(ID_PLACEHOLDER, out)
    return out


def redact_messages(messages: list) -> list:
    """Redact the user/assistant turns of a chat-message list in place-safe form.

    System prompts are Grindly-authored instructions with no user PII, so they
    pass through untouched — redacting them would risk corrupting the schema
    hints the models rely on.
    """
    if not _enabled():
        return messages
    redacted = []
    for message in messages:
        if isinstance(message, dict) and message.get("role") in ("user", "assistant"):
            content = message.get("content")
            if isinstance(content, str):
                redacted.append({**message, "content": redact_pii(content)})
                continue
        redacted.append(message)
    return redacted
