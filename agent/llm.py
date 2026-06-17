"""Tiny local-LLM helper. Uses Ollama (qwen3:4b-instruct) over its REST API so
the agent's reasoning stays free + private, per the 'free at runtime' rule.

Falls back gracefully: if Ollama is down, callers get None and use heuristics.
"""
from __future__ import annotations
import json
import os
import re
import urllib.request

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
MODEL = os.environ.get("INTERNPILOT_MODEL", "qwen3:4b-instruct")


def _post(path: str, payload: dict, timeout: int = 120) -> dict | None:
    try:
        req = urllib.request.Request(
            f"{OLLAMA}{path}",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:  # noqa: BLE001
        print(f"[llm] ollama unavailable: {e}")
        return None


def chat(prompt: str, system: str = "", timeout: int = 120) -> str | None:
    msgs = []
    if system:
        msgs.append({"role": "system", "content": system})
    msgs.append({"role": "user", "content": prompt})
    out = _post("/api/chat", {"model": MODEL, "messages": msgs, "stream": False}, timeout)
    if not out:
        return None
    return (out.get("message") or {}).get("content")


def chat_json(prompt: str, system: str = "", timeout: int = 120):
    """Ask for JSON, tolerate code fences / stray prose, return parsed or None."""
    raw = chat(prompt, system, timeout)
    if not raw:
        return None
    return _extract_json(raw)


def _extract_json(text: str):
    # strip <think> blocks some qwen variants emit
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
    # try fenced block first
    m = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.S)
    candidate = m.group(1) if m else text
    # grab first {...} or [...]
    m2 = re.search(r"(\{.*\}|\[.*\])", candidate, flags=re.S)
    if not m2:
        return None
    try:
        return json.loads(m2.group(1))
    except Exception:  # noqa: BLE001
        return None
