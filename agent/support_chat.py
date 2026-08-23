"""The support assistant: one reply in a user's support conversation.

Given the conversation so far plus what the product knows about itself, it
returns the next reply AND the operator's running summary of the problem —
so the human never has to read a thread to know what it is about. It also
decides when to hand over: billing, bugs it cannot resolve, anything about
data or deletion, or simply "I want a person".

What it may NOT do is as important as what it does: it cannot see the
account beyond the small `user_context` it is handed, so it never asserts
facts about a plan, a charge or a run it was not told; and it never pretends
to be a person — warm and plain-spoken, yes, but "I'm Grindly's assistant"
when asked.

Returns a dict: {reply, summary, category, subject, escalate}. On any model
failure it returns a safe hand-over reply with escalate=True, so the user is
never left without an answer and the operator is told.
"""
from __future__ import annotations

import json
import re
from typing import Any

import llm as llm_mod

CATEGORIES = ("billing", "rebuild", "upload", "account", "bug", "feature", "other")

_SYSTEM = """You are Grindly's support assistant. Grindly is a resume-readiness tool: a person
uploads a resume, it measures what a machine parser actually recovers from the file
(a 0-100 score from arithmetic, not opinion), rebuilds the resume as a clean
single-column PDF, and tailors it to a company — without ever inventing a skill,
a date, a number or an employer. Free tier: full report + a few lifetime rebuilds.
Paid: ₹99 unlocks one company forever; ₹399 Season Pass = unlimited for 90 days
(USD prices abroad are shown but checkout abroad is not open yet).

HOW TO TALK: like a helpful, calm person. Plain words, short paragraphs, no
bullet-point dumps, no corporate tone, no exclamation marks. Acknowledge the
problem in one line, then help. Ask at most ONE clarifying question, only when
you truly cannot help without it. Never pretend to be human — if asked, say you
are Grindly's assistant and that a person reads every conversation you hand over.

WHAT YOU KNOW is in the PRODUCT NOTES below. Use them. Do NOT invent anything
about this person's account, plan, charges or runs beyond USER CONTEXT — if you
need that to help, say so and hand over.

HAND OVER (escalate=true) when: they ask for a person; anything about money
(charged, refund, payment failed, wrong plan); account deletion or data requests;
a bug you could not resolve with the notes after one exchange; they are clearly
frustrated after two exchanges; or you simply do not know. When handing over, tell
them plainly that a person will pick this up and reply here (and by email), and
what you have passed on.

ALWAYS return ONLY this JSON object, nothing else:
{"reply": "<your message to the user>",
 "summary": "<1-3 sentences FOR THE OPERATOR: who, what is wrong, what was tried, what they need now>",
 "category": "<one of: billing, rebuild, upload, account, bug, feature, other>",
 "subject": "<at most 8 words naming the issue>",
 "escalate": true|false}
"""


def _coerce(parsed: Any) -> dict | None:
    if not isinstance(parsed, dict):
        return None
    reply = str(parsed.get("reply") or "").strip()
    if not reply:
        return None
    category = str(parsed.get("category") or "other").strip().lower()
    if category not in CATEGORIES:
        category = "other"
    subject = re.sub(r"\s+", " ", str(parsed.get("subject") or "")).strip()[:80]
    summary = str(parsed.get("summary") or "").strip()[:1200]
    escalate = bool(parsed.get("escalate"))
    return {
        "reply": reply[:4000],
        "summary": summary,
        "category": category,
        "subject": subject,
        "escalate": escalate,
    }


HANDOVER_REPLY = (
    "I couldn't reach my own brain just now, so I won't guess. I've passed this "
    "conversation to a person on the Grindly team — they will reply right here and "
    "you will get an email when they do."
)


def answer(
    messages: list[dict],
    knowledge: str,
    user_context: str = "",
    timeout: int = 60,
) -> dict:
    """One assistant turn. `messages` is the thread so far as
    [{"role": "user"|"assistant"|"admin", "content": str}, ...]."""
    transcript = []
    for m in messages[-16:]:
        role = str(m.get("role") or "user")
        who = {"user": "USER", "assistant": "ASSISTANT", "admin": "GRINDLY TEAM (human)"}.get(role, "USER")
        transcript.append(f"{who}: {str(m.get('content') or '').strip()[:2000]}")
    prompt = (
        f"PRODUCT NOTES:\n{knowledge.strip()[:6000]}\n\n"
        f"USER CONTEXT:\n{(user_context or 'nothing beyond this conversation').strip()[:800]}\n\n"
        f"CONVERSATION SO FAR:\n" + "\n\n".join(transcript) +
        "\n\nWrite the next ASSISTANT turn as the JSON object described."
    )
    try:
        parsed = llm_mod.chat_json(prompt, system=_SYSTEM, timeout=timeout, validator=lambda p: _coerce(p) is not None)
    except Exception as error:  # the ensemble is built not to throw; belt and braces
        print(f"[support] assistant call failed: {error}")
        parsed = None
    result = _coerce(parsed)
    if result is None:
        last_user = next((m for m in reversed(messages) if m.get("role") == "user"), None)
        gist = str(last_user.get("content") if last_user else "")[:300]
        return {
            "reply": HANDOVER_REPLY,
            "summary": f"Assistant unavailable (model failure). User wrote: {gist}",
            "category": "other",
            "subject": (gist[:60] or "Support request"),
            "escalate": True,
            "fallback": True,
        }
    result["fallback"] = False
    return result


def parse_json(raw: str) -> dict | None:
    """Exposed for tests: the same coercion the live path applies."""
    return _coerce(llm_mod._extract_json(raw))
