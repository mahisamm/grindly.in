"""Regression tests for multi-provider LLM selection, resilience, and fusion."""
import io
import json
import os
import sys
import time
import urllib.error
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import llm


@pytest.fixture(autouse=True)
def reset_provider_state(monkeypatch):
    llm._provider_health.clear()
    for key in ("GROQ_API_KEY", "GEMINI_API_KEY", "CEREBRAS_API_KEY", "MISTRAL_API_KEY"):
        monkeypatch.delenv(key, raising=False)


def _provider(name, backend, key, result, delay=0.0):
    def call(_messages, _timeout, _temperature=0.3):
        time.sleep(delay)
        return result

    return llm.Provider(name, call, key, backend)


def test_selection_skips_unconfigured_providers_and_prefers_distinct_backends(monkeypatch):
    providers = [
        _provider("groq-a", "groq", "GROQ_API_KEY", "a"),
        _provider("missing", "cerebras", "CEREBRAS_API_KEY", "b"),
        _provider("groq-b", "groq", "GROQ_API_KEY", "c"),
        _provider("gemini", "gemini", "GEMINI_API_KEY", "d"),
    ]
    monkeypatch.setattr(llm, "PROVIDERS", providers)
    monkeypatch.setenv("GROQ_API_KEY", "configured")
    monkeypatch.setenv("GEMINI_API_KEY", "configured")

    selected = llm._select_providers(2)

    assert [provider.name for provider in selected] == ["groq-a", "gemini"]


def test_ensemble_calls_providers_in_parallel(monkeypatch):
    providers = [
        _provider("one", "one", "KEY_ONE", "one", delay=0.15),
        _provider("two", "two", "KEY_TWO", "two", delay=0.15),
        _provider("three", "three", "KEY_THREE", "three", delay=0.15),
    ]
    monkeypatch.setattr(llm, "PROVIDERS", providers)
    for key in ("KEY_ONE", "KEY_TWO", "KEY_THREE"):
        monkeypatch.setenv(key, "configured")

    started = time.perf_counter()
    results = llm.chat_ensemble("prompt", n=3)
    elapsed = time.perf_counter() - started

    assert set(results) == {"one", "two", "three"}
    assert elapsed < 0.35


def test_ensemble_threads_temperature_to_providers(monkeypatch):
    # resume_ai.analyze() scores at temperature=0.0 so a resume score doesn't swing
    # across repeated "Re-analyze" presses. Prove the value actually reaches the
    # provider call and isn't silently dropped at 0.3.
    seen = []

    def call(_messages, _timeout, temperature=0.3):
        seen.append(temperature)
        return "ok"

    monkeypatch.setattr(llm, "PROVIDERS", [llm.Provider("p", call, "KEY_P", "p")])
    monkeypatch.setenv("KEY_P", "configured")

    llm.chat_ensemble("prompt", n=1, temperature=0.0)
    assert seen == [0.0]


def test_boolean_fusion_preserves_boolean_type():
    result = llm._merge_json(
        [{"eligible": True}, {"eligible": True}, {"eligible": False}]
    )
    assert result["eligible"] is True
    assert isinstance(result["eligible"], bool)


def test_boolean_disagreement_fails_closed():
    assert llm._merge_json([{"eligible": True}, {"eligible": False}]) == {
        "eligible": False
    }


def test_numeric_fusion_uses_median_to_reject_outlier():
    assert llm._merge_json([{"score": 70}, {"score": 72}, {"score": 100}]) == {
        "score": 72
    }


def test_list_fusion_requires_majority_support():
    result = llm._merge_json(
        [
            {"skills": ["Python", "InventedSkill"]},
            {"skills": ["python", "SQL"]},
            {"skills": ["Python", "SQL"]},
        ]
    )
    assert result == {"skills": ["Python", "SQL"]}


def test_field_from_only_one_model_is_not_accepted():
    result = llm._merge_json(
        [{"score": 80, "invented": "claim"}, {"score": 82}, {"score": 81}]
    )
    assert result == {"score": 81}


def test_nested_objects_are_merged_recursively():
    result = llm._merge_json(
        [
            {"candidate": {"eligible": True, "score": 70}},
            {"candidate": {"eligible": False, "score": 72}},
            {"candidate": {"eligible": True, "score": 90}},
        ]
    )
    assert result == {"candidate": {"eligible": True, "score": 72}}


def test_invalid_json_is_ignored_and_validator_rejects_bad_shape(monkeypatch):
    monkeypatch.setattr(
        llm,
        "chat_ensemble",
        lambda *_args, **_kwargs: ["not json", '{"score":"bad"}', '{"score":88}'],
    )
    result = llm.chat_json_ensemble(
        "prompt", validator=lambda item: isinstance(item.get("score"), int)
    )
    assert result == {"score": 88}


def test_circuit_breaker_removes_repeatedly_failing_provider(monkeypatch):
    failing = _provider("failing", "one", "KEY_ONE", None)
    healthy = _provider("healthy", "two", "KEY_TWO", "ok")
    monkeypatch.setattr(llm, "PROVIDERS", [failing, healthy])
    monkeypatch.setenv("KEY_ONE", "configured")
    monkeypatch.setenv("KEY_TWO", "configured")
    monkeypatch.setattr(llm, "_CIRCUIT_FAILURE_THRESHOLD", 2)

    llm._call_provider(failing, [], 1)
    llm._call_provider(failing, [], 1)

    assert [provider.name for provider in llm._select_providers(2)] == ["healthy"]


class _FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return json.dumps(self.payload).encode()


def test_http_429_is_retried(monkeypatch):
    attempts = {"count": 0}

    def urlopen(_req, timeout):
        assert timeout == 2
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise urllib.error.HTTPError(
                "https://provider.test", 429, "rate limited", {}, io.BytesIO()
            )
        return _FakeResponse({"ok": True})

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(llm.time, "sleep", lambda _seconds: None)
    monkeypatch.setattr(llm, "_MAX_RETRIES", 2)

    assert llm._urlopen_json(llm.urllib.request.Request("https://provider.test"), 2) == {
        "ok": True
    }
    assert attempts["count"] == 2


# ---------- a reasoning model that thinks past its budget ----------

def _fake_response(payload: dict):
    def _urlopen(_req, _timeout):
        return payload
    return _urlopen


def test_a_reply_with_no_content_is_a_clean_failure_not_a_keyerror(monkeypatch):
    """A reasoning model that spends its whole completion budget thinking returns
    a message with NO "content" key: {"role", "reasoning"} and
    finish_reason="length". Reading ["content"] raised KeyError('content'), which
    reached the logs as an unexplained provider error and silently cost the
    ensemble a third of its votes on every substantial call."""
    monkeypatch.setattr(llm, "_urlopen_json", _fake_response({
        "choices": [{"finish_reason": "length",
                     "message": {"role": "assistant", "reasoning": "thinking..."}}]}))
    out = llm._openai_compat("https://api.x/v1", "key", "model", [{"role": "user", "content": "hi"}], 10)
    assert out is None


def test_a_normal_reply_still_comes_back(monkeypatch):
    monkeypatch.setattr(llm, "_urlopen_json", _fake_response({
        "choices": [{"finish_reason": "stop",
                     "message": {"role": "assistant", "content": '{"ok": true}'}}]}))
    out = llm._openai_compat("https://api.x/v1", "key", "model", [{"role": "user", "content": "hi"}], 10)
    assert out == '{"ok": true}'


def test_the_reasoning_provider_asks_for_enough_budget_to_answer(monkeypatch):
    """Measured on a real resume prompt: 4,834 reasoning tokens before a 5,520
    character answer. At the 2,048 default it returned finish_reason=length and no
    answer at all — every time."""
    seen = {}

    def _capture(req, _timeout):
        seen["body"] = json.loads(req.data.decode())
        return {"choices": [{"finish_reason": "stop",
                             "message": {"role": "assistant", "content": "ok"}}]}

    monkeypatch.setattr(llm, "_urlopen_json", _capture)
    monkeypatch.setenv("CEREBRAS_API_KEY", "configured")
    llm._cerebras_glm([{"role": "user", "content": "hi"}], 10)
    assert seen["body"]["max_tokens"] >= 8192
    assert llm._REASONING_MAX_TOKENS > llm._DEFAULT_MAX_TOKENS
