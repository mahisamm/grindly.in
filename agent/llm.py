"""Fault-tolerant multi-provider LLM fusion for Grindly's agent.

Configured providers are selected dynamically, independent backends are preferred,
calls run in parallel, and structured answers are merged by consensus. A failed or
rate-limited provider degrades the answer instead of stopping the user workflow.
"""
from __future__ import annotations

import concurrent.futures
import json
import os
import re
import statistics
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from typing import Callable

import redact

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
_MAX_RETRIES = max(1, int(os.environ.get("GRINDLY_LLM_MAX_RETRIES", "3")))
_RETRY_BASE_SECONDS = max(
    0.0, float(os.environ.get("GRINDLY_LLM_RETRY_BASE_SECONDS", "0.5"))
)
_CIRCUIT_FAILURE_THRESHOLD = max(
    1, int(os.environ.get("GRINDLY_LLM_CIRCUIT_FAILURES", "3"))
)
_CIRCUIT_COOLDOWN_SECONDS = max(
    1.0, float(os.environ.get("GRINDLY_LLM_CIRCUIT_COOLDOWN_SECONDS", "60"))
)


@dataclass(frozen=True)
class Provider:
    name: str
    fn: Callable[..., str | None]
    key_env: str
    backend: str


_health_lock = threading.Lock()
_provider_health: dict[str, dict[str, float]] = {}


def _retry_delay(error: Exception, attempt: int) -> float:
    if isinstance(error, urllib.error.HTTPError):
        retry_after = error.headers.get("Retry-After") if error.headers else None
        if retry_after:
            try:
                return min(10.0, max(0.0, float(retry_after)))
            except ValueError:
                pass
    return min(10.0, _RETRY_BASE_SECONDS * (2**attempt))


def _urlopen_json(req: urllib.request.Request, timeout: int) -> dict:
    """Open an LLM request with bounded retries for transient failures."""
    last_error: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            last_error = error
            if error.code not in (408, 409, 425, 429) and error.code < 500:
                raise
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
        if attempt + 1 < _MAX_RETRIES:
            time.sleep(_retry_delay(last_error, attempt))
    assert last_error is not None
    raise last_error


def _openai_compat(
    base_url: str, api_key: str, model: str, messages: list, timeout: int,
    temperature: float = 0.3,
) -> str | None:
    if not api_key:
        return None
    try:
        payload = json.dumps(
            {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": 2048,
            }
        ).encode()
        req = urllib.request.Request(
            f"{base_url}/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": _UA,
            },
        )
        data = _urlopen_json(req, timeout)
        return data["choices"][0]["message"]["content"]
    except Exception as error:
        print(f"[llm] {base_url} ({model}) error: {error}")
        return None


def _gemini(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        contents = []
        system_text = None
        for message in messages:
            if message["role"] == "system":
                system_text = message["content"]
            elif message["role"] == "user":
                contents.append(
                    {"role": "user", "parts": [{"text": message["content"]}]}
                )
            elif message["role"] == "assistant":
                contents.append(
                    {"role": "model", "parts": [{"text": message["content"]}]}
                )

        payload: dict = {
            "contents": contents,
            "generationConfig": {"temperature": temperature, "maxOutputTokens": 2048},
        }
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"gemini-2.0-flash:generateContent?key={api_key}"
        )
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "User-Agent": _UA},
        )
        data = _urlopen_json(req, timeout)
        return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as error:
        print(f"[llm] Gemini error: {error}")
        return None


def _groq_llama(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    return _openai_compat(
        "https://api.groq.com/openai/v1",
        os.environ.get("GROQ_API_KEY", ""),
        "llama-3.3-70b-versatile",
        messages,
        timeout,
        temperature,
    )


def _cerebras_glm(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    return _openai_compat(
        "https://api.cerebras.ai/v1",
        os.environ.get("CEREBRAS_API_KEY", ""),
        "zai-glm-4.7",
        messages,
        timeout,
        temperature,
    )


def _mistral(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    return _openai_compat(
        "https://api.mistral.ai/v1",
        os.environ.get("MISTRAL_API_KEY", ""),
        "mistral-small-latest",
        messages,
        timeout,
        temperature,
    )


def _groq_gptoss(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    return _openai_compat(
        "https://api.groq.com/openai/v1",
        os.environ.get("GROQ_API_KEY", ""),
        "openai/gpt-oss-120b",
        messages,
        timeout,
        temperature,
    )


PROVIDERS: list[Provider] = [
    Provider("groq-llama-3.3-70b", _groq_llama, "GROQ_API_KEY", "groq"),
    Provider("cerebras-glm-4.7", _cerebras_glm, "CEREBRAS_API_KEY", "cerebras"),
    Provider("mistral-small", _mistral, "MISTRAL_API_KEY", "mistral"),
    Provider("groq-gpt-oss-120b", _groq_gptoss, "GROQ_API_KEY", "groq"),
    Provider("gemini-2.0-flash", _gemini, "GEMINI_API_KEY", "gemini"),
]


def _build_messages(prompt: str, system: str = "") -> list:
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    # Single egress choke point: every outbound prompt is stripped of direct
    # personal identifiers (email/phone/ID) before it reaches a third-party
    # provider. See agent/redact.py.
    return redact.redact_messages(messages)


def _extract_json(text: str):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    candidate = fenced.group(1) if fenced else text
    embedded = re.search(r"(\{.*\}|\[.*\])", candidate, flags=re.S)
    if not embedded:
        return None
    try:
        return json.loads(embedded.group(1))
    except (TypeError, json.JSONDecodeError):
        return None


def _configured_providers() -> list[Provider]:
    return [p for p in PROVIDERS if os.environ.get(p.key_env, "").strip()]


def _circuit_open(provider: Provider, now: float | None = None) -> bool:
    now = time.monotonic() if now is None else now
    with _health_lock:
        state = _provider_health.get(provider.name)
        return bool(state and state.get("open_until", 0.0) > now)


def _record_provider_result(provider: Provider, ok: bool) -> None:
    with _health_lock:
        state = _provider_health.setdefault(
            provider.name, {"failures": 0.0, "open_until": 0.0}
        )
        if ok:
            state["failures"] = 0.0
            state["open_until"] = 0.0
            return
        state["failures"] += 1.0
        if state["failures"] >= _CIRCUIT_FAILURE_THRESHOLD:
            state["open_until"] = time.monotonic() + _CIRCUIT_COOLDOWN_SECONDS


def _call_provider(provider: Provider, messages: list, timeout: int,
                   temperature: float = 0.3) -> str | None:
    try:
        result = provider.fn(messages, timeout, temperature)
    except Exception as error:
        print(f"[llm] provider {provider.name} error: {error}")
        result = None
    ok = bool(result and result.strip())
    _record_provider_result(provider, ok)
    return result.strip() if ok and result else None


def _select_providers(n: int) -> list[Provider]:
    """Select configured healthy providers, preferring independent backends."""
    if n <= 0:
        return []
    configured = _configured_providers()
    healthy = [provider for provider in configured if not _circuit_open(provider)]
    candidates = healthy or configured
    selected: list[Provider] = []
    used_backends: set[str] = set()
    for provider in candidates:
        if provider.backend not in used_backends:
            selected.append(provider)
            used_backends.add(provider.backend)
            if len(selected) >= n:
                return selected
    for provider in candidates:
        if provider not in selected:
            selected.append(provider)
            if len(selected) >= n:
                break
    return selected


def _signature(value) -> str:
    if isinstance(value, str):
        return " ".join(value.casefold().split())
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except TypeError:
        return repr(value)


def _merge_lists(values: list[list]) -> list:
    """Keep only items supported by a strict majority of model responses.

    This is a DELIBERATE precision-over-recall choice, not an oversight. An item
    only one model produced is dropped — which does cost some recall on niche
    skills that a single provider caught (and the skill-extraction eval gate in
    eval_llm.py is recall-based, so the two pull against each other). It stays
    strict on purpose: loosening it to accept single-model items would let one
    provider's hallucinated skill onto a real resume/application, breaking the
    "never claim a skill the candidate can't back up" guarantee that questions.py
    and resume_optimize.py are built around. Fabrication risk outweighs a missed
    niche skill, so the majority floor stays.
    """
    threshold = len(values) // 2 + 1
    counts: Counter[str] = Counter()
    originals: dict[str, object] = {}
    order: list[str] = []
    for items in values:
        present: set[str] = set()
        for item in items:
            signature = _signature(item)
            if signature not in originals:
                originals[signature] = item
                order.append(signature)
            present.add(signature)
        counts.update(present)
    return [originals[sig] for sig in order if counts[sig] >= threshold]


def _merge_values(values: list):
    if all(isinstance(value, bool) for value in values):
        # A tie is not evidence of truth. For safety decisions, disagreement
        # resolves to False instead of turning one model's guess into consent.
        return sum(values) > len(values) / 2
    if all(
        isinstance(value, (int, float)) and not isinstance(value, bool)
        for value in values
    ):
        median = statistics.median(values)
        return round(median) if all(isinstance(value, int) for value in values) else median
    if all(isinstance(value, dict) for value in values):
        return _merge_json(values)
    if all(isinstance(value, list) for value in values):
        return _merge_lists(values)
    signatures = [_signature(value) for value in values]
    winner, _ = Counter(signatures).most_common(1)[0]
    matches = [value for value, sig in zip(values, signatures) if sig == winner]
    if all(isinstance(value, str) for value in matches):
        return max(matches, key=len)
    return matches[0]


def _merge_json(results: list[dict]) -> dict:
    """Merge JSON without changing types or accepting one-model list items."""
    all_keys: set[str] = set()
    for result in results:
        if isinstance(result, dict):
            all_keys.update(result.keys())
    merged: dict = {}
    key_threshold = len(results) // 2 + 1
    for key in all_keys:
        values = [result[key] for result in results if key in result]
        if len(values) >= key_threshold:
            merged[key] = _merge_values(values)
    return merged


def chat(prompt: str, system: str = "", timeout: int = 60) -> str | None:
    """Try configured healthy providers in order and return the first success."""
    messages = _build_messages(prompt, system)
    providers = _select_providers(len(PROVIDERS))
    for provider in providers:
        result = _call_provider(provider, messages, timeout)
        if result:
            print(f"[llm] served by {provider.name}")
            return result
    print("[llm] all configured providers failed" if providers else "[llm] no providers configured")
    return None


def chat_ensemble(
    prompt: str, system: str = "", n: int = 3, timeout: int = 60,
    temperature: float = 0.3,
) -> list[str]:
    """Call configured providers in parallel, preferring independent backends.

    temperature defaults to 0.3; scoring/evaluation callers (e.g. resume_ai.analyze)
    pass 0.0 so the SAME input yields a near-identical answer every run — a resume
    score must not swing 80→88→90 across repeated "Re-analyze" presses.
    """
    messages = _build_messages(prompt, system)
    providers = _select_providers(n)
    if not providers:
        print("[llm] no providers configured")
        return []
    results_by_name: dict[str, str] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(providers)) as executor:
        futures = {
            executor.submit(_call_provider, provider, messages, timeout, temperature): provider.name
            for provider in providers
        }
        for future in concurrent.futures.as_completed(futures):
            name = futures[future]
            try:
                result = future.result()
                if result:
                    results_by_name[name] = result
                    print(f"[llm] ensemble OK {name}")
            except Exception as error:
                print(f"[llm] ensemble FAIL {name}: {error}")
    return [results_by_name[p.name] for p in providers if p.name in results_by_name]


def chat_json(prompt: str, system: str = "", timeout: int = 60, validator=None):
    """Single-provider call returning parsed, optionally validated JSON."""
    raw = chat(prompt, system, timeout)
    parsed = _extract_json(raw) if raw else None
    return parsed if parsed is not None and (validator is None or validator(parsed)) else None


def chat_json_ensemble(
    prompt: str,
    system: str = "",
    n: int = 3,
    timeout: int = 60,
    validator=None,
    temperature: float = 0.3,
):
    """Return a consensus merge of all valid structured provider answers."""
    responses = chat_ensemble(prompt, system, n, timeout, temperature)
    parsed = [_extract_json(response) for response in responses if response]
    parsed = [item for item in parsed if item is not None]
    if validator is not None:
        parsed = [item for item in parsed if validator(item)]
    if not parsed:
        return None
    if len(parsed) == 1:
        print("[llm] degraded ensemble: only one valid provider response")
        return parsed[0]
    if all(isinstance(item, list) for item in parsed):
        merged_list = _merge_lists(parsed)
        print(f"[llm] merged {len(parsed)} list responses ({len(merged_list)} items)")
        return merged_list
    dictionaries = [item for item in parsed if isinstance(item, dict)]
    if not dictionaries:
        return parsed[0]
    merged = _merge_json(dictionaries)
    print(f"[llm] merged {len(dictionaries)} dict responses into ensemble result")
    return merged
