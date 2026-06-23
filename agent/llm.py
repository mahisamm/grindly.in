"""
Fusion LLM — calls up to 5 providers in parallel and aggregates results.

Providers (all free tier), mixed families for ensemble diversity:
  1. Groq  Llama-3.3-70B       (GROQ_API_KEY)      — Meta
  2. Cerebras GLM-4.7          (CEREBRAS_API_KEY)  — Zhipu
  3. Mistral Small             (MISTRAL_API_KEY)   — Mistral
  4. Groq  GPT-OSS-120B        (GROQ_API_KEY)      — OpenAI OSS
  5. Google Gemini 2.0 Flash   (GEMINI_API_KEY)    — Google

chat()               → tries providers in order, returns first success
chat_ensemble()      → calls top-n in parallel, returns all responses
chat_json()          → single-provider, returns parsed JSON or None
chat_json_ensemble() → ensemble + merges JSON (avg numbers, union arrays)
"""
from __future__ import annotations
import concurrent.futures
import json
import os
import re
import urllib.request
import urllib.error

# Browser-like UA — Groq/Cerebras sit behind Cloudflare, which 403s (error 1010)
# the default "Python-urllib" agent. Send a real UA on every request.
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)


# ── provider implementations ──────────────────────────────────────

def _openai_compat(
    base_url: str, api_key: str, model: str, messages: list, timeout: int
) -> str | None:
    if not api_key:
        return None
    try:
        payload = json.dumps({
            "model": model,
            "messages": messages,
            "temperature": 0.3,
        }).encode()
        req = urllib.request.Request(
            f"{base_url}/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": _UA,
            },
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
            return data["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"[llm] {base_url} ({model}) error: {e}")
        return None


def _gemini(messages: list, timeout: int) -> str | None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return None
    try:
        contents = []
        system_text = None
        for m in messages:
            if m["role"] == "system":
                system_text = m["content"]
            elif m["role"] == "user":
                contents.append({"role": "user", "parts": [{"text": m["content"]}]})
            elif m["role"] == "assistant":
                contents.append({"role": "model", "parts": [{"text": m["content"]}]})

        payload: dict = {
            "contents": contents,
            "generationConfig": {"temperature": 0.3},
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
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode())
            return data["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        print(f"[llm] Gemini error: {e}")
        return None


def _groq_llama(messages: list, timeout: int) -> str | None:
    return _openai_compat(
        "https://api.groq.com/openai/v1",
        os.environ.get("GROQ_API_KEY", ""),
        "llama-3.3-70b-versatile",
        messages, timeout,
    )


def _cerebras_glm(messages: list, timeout: int) -> str | None:
    # GLM-4.7 on Cerebras — distinct model family for ensemble diversity
    return _openai_compat(
        "https://api.cerebras.ai/v1",
        os.environ.get("CEREBRAS_API_KEY", ""),
        "zai-glm-4.7",
        messages, timeout,
    )


def _mistral(messages: list, timeout: int) -> str | None:
    return _openai_compat(
        "https://api.mistral.ai/v1",
        os.environ.get("MISTRAL_API_KEY", ""),
        "mistral-small-latest",
        messages, timeout,
    )


def _groq_gptoss(messages: list, timeout: int) -> str | None:
    # GPT-OSS 120B on Groq — large, different family (mixtral was decommissioned)
    return _openai_compat(
        "https://api.groq.com/openai/v1",
        os.environ.get("GROQ_API_KEY", ""),
        "openai/gpt-oss-120b",
        messages, timeout,
    )


# Ordered by preference — best/fastest first. Mix of families for ensemble
# diversity: Llama (Meta), GLM (Zhipu), Mistral, GPT-OSS (OpenAI), Gemini (Google).
PROVIDERS: list[tuple[str, object]] = [
    ("groq-llama-3.3-70b",  _groq_llama),
    ("cerebras-glm-4.7",    _cerebras_glm),
    ("mistral-small",       _mistral),
    ("groq-gpt-oss-120b",   _groq_gptoss),
    ("gemini-2.0-flash",    _gemini),
]


# ── helpers ───────────────────────────────────────────────────────

def _build_messages(prompt: str, system: str = "") -> list:
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    return msgs


def _extract_json(text: str):
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    m = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    candidate = m.group(1) if m else text
    m2 = re.search(r"(\{.*\}|\[.*\])", candidate, flags=re.S)
    if not m2:
        return None
    try:
        return json.loads(m2.group(1))
    except Exception:
        return None


def _merge_json(results: list[dict]) -> dict:
    """Merge N JSON dicts: average numbers, union arrays (deduplicated), longest string wins."""
    all_keys: set[str] = set()
    for r in results:
        if isinstance(r, dict):
            all_keys.update(r.keys())

    merged: dict = {}
    for key in all_keys:
        values = [r[key] for r in results if isinstance(r, dict) and key in r]
        if not values:
            continue
        if all(isinstance(v, (int, float)) for v in values):
            merged[key] = round(sum(values) / len(values))
        elif all(isinstance(v, list) for v in values):
            seen: set[str] = set()
            combined: list = []
            for lst in values:
                for item in lst:
                    sig = str(item).lower().strip()
                    if sig not in seen:
                        seen.add(sig)
                        combined.append(item)
            merged[key] = combined
        else:
            str_vals = [str(v) for v in values if v]
            merged[key] = max(str_vals, key=len) if str_vals else values[0]

    return merged


# ── public API ────────────────────────────────────────────────────

def chat(prompt: str, system: str = "", timeout: int = 60) -> str | None:
    """Try providers in order, return first success."""
    msgs = _build_messages(prompt, system)
    for name, fn in PROVIDERS:
        result = fn(msgs, timeout)  # type: ignore[operator]
        if result and result.strip():
            print(f"[llm] served by {name}")
            return result.strip()
    print("[llm] all providers failed")
    return None


def chat_ensemble(
    prompt: str, system: str = "", n: int = 3, timeout: int = 60
) -> list[str]:
    """Call top-n providers in parallel, return all non-empty responses."""
    msgs = _build_messages(prompt, system)
    subset = PROVIDERS[:n]
    results: list[str] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        futures = {
            ex.submit(fn, msgs, timeout): name  # type: ignore[operator]
            for name, fn in subset
        }
        for fut in concurrent.futures.as_completed(futures):
            name = futures[fut]
            try:
                r = fut.result()
                if r and r.strip():
                    results.append(r.strip())
                    print(f"[llm] ensemble OK {name}")
            except Exception as e:
                print(f"[llm] ensemble FAIL {name}: {e}")

    return results


def chat_json(prompt: str, system: str = "", timeout: int = 60):
    """Single-provider call, returns parsed JSON or None."""
    raw = chat(prompt, system, timeout)
    return _extract_json(raw) if raw else None


def chat_json_ensemble(
    prompt: str, system: str = "", n: int = 3, timeout: int = 60
):
    """Ensemble JSON — merge results from n providers into one richer answer.

    Handles both dict results (resume analysis) and list results (skill arrays).
    """
    responses = chat_ensemble(prompt, system, n, timeout)
    parsed = [_extract_json(r) for r in responses if r]
    parsed = [p for p in parsed if p is not None]
    if not parsed:
        return None
    if len(parsed) == 1:
        return parsed[0]

    # All lists → union merge (skill extraction case)
    if all(isinstance(p, list) for p in parsed):
        seen: set[str] = set()
        merged_list: list = []
        for lst in parsed:
            for item in lst:
                sig = str(item).lower().strip()
                if sig not in seen:
                    seen.add(sig)
                    merged_list.append(item)
        print(f"[llm] merged {len(parsed)} list responses ({len(merged_list)} items)")
        return merged_list

    # All dicts → field-level merge
    dicts = [p for p in parsed if isinstance(p, dict)]
    if not dicts:
        return parsed[0]
    merged = _merge_json(dicts)
    print(f"[llm] merged {len(dicts)} dict responses into ensemble result")
    return merged
