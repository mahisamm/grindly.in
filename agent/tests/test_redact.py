"""Tests for PII redaction at the LLM egress boundary (agent/redact.py)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import redact


@pytest.fixture(autouse=True)
def _enable(monkeypatch):
    # Redaction is on by default; pin it so a stray env var can't flip the suite.
    monkeypatch.setenv("GRINDLY_REDACT_PII", "1")


def test_email_is_redacted():
    out = redact.redact_pii("Reach me at priya.sharma+jobs@gmail.com anytime.")
    assert "priya.sharma" not in out
    assert "@gmail.com" not in out
    assert redact.EMAIL_PLACEHOLDER in out


def test_indian_mobile_is_redacted():
    for raw in ("9876543210", "+91 98765 43210", "+91-9876543210", "(091) 98765-43210"):
        out = redact.redact_pii(f"Phone: {raw}")
        assert not any(ch.isdigit() for ch in out.split("Phone:")[1]), raw
        assert redact.PHONE_PLACEHOLDER in out


def test_dates_years_gpa_and_pincode_survive():
    text = "B.Tech 2020-2024, CGPA 8.6/10, based in Hyderabad 500081."
    out = redact.redact_pii(text)
    assert "2020-2024" in out
    assert "8.6/10" in out
    assert "500081" in out
    assert redact.PHONE_PLACEHOLDER not in out


def test_skills_and_prose_are_untouched():
    text = "Built React and Python services with Postgres and Docker."
    assert redact.redact_pii(text) == text


def test_long_id_run_is_redacted():
    out = redact.redact_pii("Card 4111111111111111 on file")
    assert "4111111111111111" not in out
    assert redact.ID_PLACEHOLDER in out


def test_disabled_env_is_a_passthrough(monkeypatch):
    monkeypatch.setenv("GRINDLY_REDACT_PII", "0")
    text = "email me: a@b.com or 9876543210"
    assert redact.redact_pii(text) == text


def test_redact_messages_skips_system_prompt():
    messages = [
        {"role": "system", "content": "Extract skills. Contact 9998887770 in schema."},
        {"role": "user", "content": "Resume of raj@x.com, ph 9876543210"},
    ]
    out = redact.redact_messages(messages)
    # System prompt (Grindly-authored, no user PII) is preserved verbatim.
    assert out[0]["content"] == messages[0]["content"]
    # User turn is scrubbed.
    assert "raj@x.com" not in out[1]["content"]
    assert "9876543210" not in out[1]["content"]


def test_non_string_and_empty_inputs_are_safe():
    assert redact.redact_pii("") == ""
    assert redact.redact_pii(None) is None
    assert redact.redact_pii(12345) == 12345


def test_redaction_is_idempotent():
    once = redact.redact_pii("a@b.com / 9876543210")
    assert redact.redact_pii(once) == once
