"""The support assistant's contract, with the model pinned.

What the UI and the admin desk depend on: a reply always comes back (even
when every provider is down — then it is the hand-over, flagged), the
category is always one the schema knows, and a hand-over request from the
user is honoured.
"""
from __future__ import annotations

import json

import llm as llm_mod
import support_chat


def _stub(monkeypatch, payload):
    monkeypatch.setattr(llm_mod, "chat", lambda prompt, system="", timeout=60: json.dumps(payload))


def test_a_good_model_answer_is_passed_through_and_normalised(monkeypatch):
    _stub(monkeypatch, {
        "reply": "That run was not charged — press Rebuild once more.",
        "summary": "User's Amazon rebuild produced nothing; told to retry.",
        "category": "REBUILD",          # case should not matter
        "subject": "Amazon rebuild produced nothing, twice in a row now",
        "escalate": False,
    })
    out = support_chat.answer([{"role": "user", "content": "Tailor for Amazon failed"}], knowledge="notes")
    assert out["reply"].startswith("That run was not charged")
    assert out["category"] == "rebuild"
    assert out["escalate"] is False
    assert out["fallback"] is False
    assert len(out["subject"]) <= 80


def test_an_unknown_category_becomes_other_never_an_invalid_enum(monkeypatch):
    _stub(monkeypatch, {"reply": "ok", "summary": "s", "category": "payments", "subject": "x", "escalate": True})
    out = support_chat.answer([{"role": "user", "content": "I was charged twice"}], knowledge="")
    assert out["category"] == "other"
    assert out["escalate"] is True


def test_every_provider_down_still_yields_a_handover_reply(monkeypatch):
    monkeypatch.setattr(llm_mod, "chat", lambda prompt, system="", timeout=60: None)
    out = support_chat.answer([{"role": "user", "content": "help me with my resume score"}], knowledge="")
    assert out["fallback"] is True
    assert out["escalate"] is True
    assert "person" in out["reply"].lower()
    assert "help me with my resume score" in out["summary"]


def test_garbage_from_the_model_is_treated_like_no_answer(monkeypatch):
    monkeypatch.setattr(llm_mod, "chat", lambda prompt, system="", timeout=60: "Sure! Here is some prose and no JSON.")
    out = support_chat.answer([{"role": "user", "content": "hi"}], knowledge="")
    assert out["fallback"] is True and out["escalate"] is True
