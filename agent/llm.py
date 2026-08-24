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
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import Counter
from dataclasses import dataclass
from typing import Callable

import redact

# An honest User-Agent.
#
# This used to spoof Chrome 125, which is pointless against an API you hold a
# key for and mildly dishonest besides. Measured against all four providers on
# production: the spoof and this string behave identically. Sending NO
# User-Agent is the one thing that fails — Groq and Cerebras sit behind
# Cloudflare, which answers a bare python-urllib with `403 error code: 1010`
# and no explanation, so the header has to exist.
_UA = "grindly/1.0 (+https://grindly.in)"
# Completion budget. A reasoning model bills its thinking against the same
# budget and needs headroom for both, or it returns nothing at all (see
# _cerebras_glm).
#
# 6144, not the 2048 this used to be. The rewrite and extraction calls return
# a WHOLE resume as JSON — for a 3,500-character resume that is ~2,500 output
# tokens, for a two-pager more. At 2048 the honest, complete answers were cut
# off mid-JSON (Groq said so: finish_reason=length) and discarded as
# unparseable, and the only survivor was whichever model had COMPRESSED the
# resume enough to fit — which the content-loss gate then rejected for
# losing 11 of 18 bullets. Seen live: a targeted run produced nothing at all
# for a perfectly ordinary resume. The cap is a ceiling, not spend: a short
# answer costs the same either way. Every current free model allows ≥8k out;
# 8192 gives a two-page resume's JSON room to come back whole.
_DEFAULT_MAX_TOKENS = max(256, int(os.environ.get("GRINDLY_LLM_MAX_TOKENS", "8192")))
_REASONING_MAX_TOKENS = max(
    _DEFAULT_MAX_TOKENS, int(os.environ.get("GRINDLY_LLM_REASONING_MAX_TOKENS", "8192"))
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
    #: True when calls to this provider cost money. Paid providers are ordered
    #: LAST in selection regardless of where they appear in PROVIDERS, so they
    #: are reached only when the free tiers cannot answer — see
    #: `_select_providers`. Making it a property of the provider rather than a
    #: property of list order means a future edit to PROVIDERS cannot quietly
    #: promote a paid backend to the default path.
    paid: bool = False
    #: True when the provider is free but on a HARD DAILY CAP rather than a
    #: rate limit that merely slows you down. Ordered after the uncapped free
    #: tiers and before the paid ones, so an allowance that resets once a day
    #: is spent covering an outage rather than serving the steady state.
    #:
    #: OpenRouter's free models are the case: 50 requests a day on an account
    #: with no credits. That is a real reserve for a closed beta and it is not a
    #: primary — a single busy afternoon would exhaust it and the failure would
    #: look like a dead provider rather than a spent allowance.
    metered: bool = False


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


def _annotate_http_error(error: urllib.error.HTTPError) -> urllib.error.HTTPError:
    """Fold the response body into the error's message.

    urllib's HTTPError prints "HTTP Error 413: Payload Too Large" and drops the
    body — which is where the provider says WHY ("Request too large for model
    ... Limit 8000, Requested 8412"). Every provider failure in this module is
    observable only through that one printed line (lib/agent.ts lifts it into
    the error table), so the body belongs in it. Read once, whitespace
    collapsed, bounded; a body that cannot be read leaves the message as it was.
    """
    try:
        body = error.read().decode("utf-8", "replace")
    except Exception:  # noqa: BLE001 — diagnostics must never raise
        return error
    body = re.sub(r"\s+", " ", body).strip()
    if body:
        error.msg = f"{error.msg} — {body[:240]}"
    return error


def _urlopen_json(req: urllib.request.Request, timeout: int) -> dict:
    """Open an LLM request with bounded retries for transient failures."""
    last_error: Exception | None = None
    for attempt in range(_MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            last_error = _annotate_http_error(error)
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
    temperature: float = 0.3, max_tokens: int = _DEFAULT_MAX_TOKENS,
) -> str | None:
    if not api_key:
        return None
    try:
        payload = json.dumps(
            {
                "model": model,
                "messages": messages,
                "temperature": temperature,
                "max_tokens": max_tokens,
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
        choice = data["choices"][0]
        content = (choice.get("message") or {}).get("content")
        if not content:
            # A reasoning model that ran out of budget mid-thought returns a
            # message with no "content" key at all — reading it directly raised
            # KeyError('content'), which surfaced as an unexplained provider
            # failure. Say what actually happened; the budget is the fix.
            print(f"[llm] {base_url} ({model}) returned no content "
                  f"(finish_reason={choice.get('finish_reason')}) — raise its max_tokens")
            return None
        return content
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
            "generationConfig": {"temperature": temperature, "maxOutputTokens": _DEFAULT_MAX_TOKENS},
        }
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}
        # gemini-2.0-flash was retired and answered 404 on production, which is
        # the third provider in this file found dead the same afternoon.
        #
        # NOT `gemini-flash-latest`, the alias that would never rot: it timed
        # out at 45s on the probe, because whatever currently sits behind it
        # thinks for longer than this pipeline is willing to wait. NOT
        # `gemini-2.5-flash` either — it wraps JSON in ```json fences, and every
        # caller here parses the answer.
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"gemini-3.6-flash:generateContent?key={api_key}"
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


# Groq's free tier rejects a request when prompt tokens + max_tokens exceed
# its per-minute allowance (~8k for these models) — with HTTP 413, before any
# generation. Raising the global cap to 8192 therefore switched Groq OFF for
# every call (seen live: 413 on "skills" and "report" the first time a user
# uploaded after the deploy). So Groq gets a budget that FITS: its limit minus
# an estimate of the prompt, floored so a useful answer is still possible; a
# prompt that leaves no room skips Groq and lets the ensemble carry on.
_GROQ_REQUEST_TOKENS = max(2048, int(os.environ.get("GRINDLY_GROQ_REQUEST_TOKENS", "8000")))
_GROQ_MIN_COMPLETION = 1024


# Characters per prompt token, for the estimate below. Resume text and the
# JSON structs this pipeline sends tokenize at ~3.3-3.6 chars/token, not the
# 4 that English prose gets — the first cut used 4, and a 24k-character prompt
# estimated at ~6k tokens was really ~7k, so prompt + budget crossed the limit
# and Groq answered 413 again (seen live, three times, after the "fix"). 3 is
# the conservative side of the measured range: a prompt that is estimated to
# fit, fits.
_GROQ_CHARS_PER_TOKEN = 3


def _groq_budget(messages: list) -> int | None:
    est_prompt = sum(len(str(m.get("content", ""))) for m in messages) // _GROQ_CHARS_PER_TOKEN + 64
    room = _GROQ_REQUEST_TOKENS - est_prompt
    if room < _GROQ_MIN_COMPLETION:
        print(f"[llm] groq skipped — prompt ~{est_prompt} tokens leaves no completion room")
        return None
    return min(_DEFAULT_MAX_TOKENS, room)


def _groq_gptoss20(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    """Groq's smaller open model.

    This slot held `llama-3.3-70b-versatile`, which Groq has since retired — the
    API answers "The model does not exist or you do not have access to it". It
    had been failing on production for an unknown length of time, silently,
    because a provider that errors is just a provider that does not contribute
    to the ensemble.

    Chosen over `qwen/qwen3.6-27b`, which is available and works but writes its
    reasoning into the response as a `<think>` block — every caller here parses
    the answer as JSON.
    """
    budget = _groq_budget(messages)
    if budget is None:
        return None
    return _openai_compat(
        "https://api.groq.com/openai/v1",
        os.environ.get("GROQ_API_KEY", ""),
        "openai/gpt-oss-20b",
        messages,
        timeout,
        temperature,
        max_tokens=budget,
    )


def _cerebras_gptoss(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    """Cerebras.

    NOTE FOR ANYONE WONDERING WHY THIS NEVER RUNS: Cerebras no longer has a free
    tier for this workload. Every model on the account answers
    `402 Payment required to access this resource`, including the two it still
    lists. The provider is kept because the code is correct and someone with a
    paid account should get the benefit of it; the key is simply absent from
    deployments that do not.

    The model was `zai-glm-4.7`, which is now "archived and unavailable". Of the
    two that remain, `gpt-oss-120b` is the general-purpose one.
    """
    return _openai_compat(
        "https://api.cerebras.ai/v1",
        os.environ.get("CEREBRAS_API_KEY", ""),
        "gpt-oss-120b",
        messages,
        timeout,
        temperature,
        # Kept from the reasoning-model era. It costs nothing when the answer is
        # short and it is the difference between an answer and an empty
        # `finish_reason=length` when it is not.
        _REASONING_MAX_TOKENS,
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
    budget = _groq_budget(messages)
    if budget is None:
        return None
    return _openai_compat(
        "https://api.groq.com/openai/v1",
        os.environ.get("GROQ_API_KEY", ""),
        "openai/gpt-oss-120b",
        messages,
        timeout,
        temperature,
        max_tokens=budget,
    )



def _openrouter(model: str):
    """One OpenRouter model, as a provider function.

    OpenRouter is an aggregator: one key reaches models from a dozen vendors, so
    it is the cheapest redundancy available to a project whose free tiers keep
    being retired underneath it — when Groq drops a model, this does not care.

    It is `metered` because the free tier is a HARD 50 requests a day on an
    account with no credits, not a rate limit that recovers in a minute.

    Both model ids were chosen by measurement rather than by reputation, against
    the one thing every caller here needs: a reply that is JSON and only JSON.
    Of the 17 free models the account can see on 20 Aug 2026, five returned
    clean parseable JSON and the rest returned an empty string, a bare `{`,
    an internal monologue, or `User Safety: safe`.
    """
    def call(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
        return _openai_compat(
            "https://openrouter.ai/api/v1",
            os.environ.get("OPENROUTER_API_KEY", ""),
            model,
            messages,
            timeout,
            temperature,
        )
    return call


def _xai(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    """Grok, over the OpenAI-compatible endpoint.

    THE MODEL ID HERE IS UNVERIFIED, and that is worth saying out loud in a file
    whose whole history is model ids rotting silently. The key on hand belongs to
    a team with no credits, so `/v1/models` answers 403 and there was no way to
    read the authoritative list — see the note in the provider-rot memory about
    never guessing names. `XAI_MODEL` overrides it without a code change, so the
    first thing to do after adding credits is list the models and set that.
    """
    return _openai_compat(
        "https://api.x.ai/v1",
        os.environ.get("XAI_API_KEY", ""),
        os.environ.get("XAI_MODEL", "grok-4-fast-non-reasoning"),
        messages,
        timeout,
        temperature,
    )


def _anthropic(messages: list, timeout: int, temperature: float = 0.3) -> str | None:
    """Claude, as a paid last resort.

    WHY THIS IS HERE AT ALL

    The other four providers are free tiers. That is the right default for this
    product — it is priced at 399 rupees for a job search and its audience is
    students — but it has one failure mode that the ensemble cannot cover: free
    tiers rate-limit on the same days, at the same hours, for the same reasons.
    A campus placement week is exactly when every provider quota is thin and
    exactly when nobody can afford the product to stop rewriting resumes.

    STRICTLY OPT-IN. With no ANTHROPIC_API_KEY set this provider is not
    configured, is never selected, and costs nothing. That is the same rule
    every other provider here follows.

    ORDERED LAST. `paid=True` puts it behind every free provider in selection,
    so on an ordinary day it is not called at all.

    COST, stated plainly for whoever decides whether to set the key: Claude
    Opus 5 is $5 per million input tokens and $25 per million output. A resume
    rewrite is roughly 2-4k in and 1-2k out, so a variant batch that falls all
    the way through to this provider costs a few US cents. Effort is set to
    `low` because these are mechanical tasks — extracting a structure, parsing
    a job description, rewriting bullets — and the depth is not what makes them
    good.
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        return None

    try:
        import anthropic
    except ImportError:
        # The key is set but the package is not installed. Reported once per
        # process rather than silently returning nothing, because "I configured
        # the paid fallback and it never runs" is otherwise undebuggable.
        print(
            "[llm] ANTHROPIC_API_KEY is set but the `anthropic` package is not "
            "installed — run: pip install anthropic",
            file=sys.stderr,
        )
        return None

    # The other providers take an OpenAI-style messages array with a `system`
    # role inside it. The Messages API takes the system prompt as its own
    # top-level parameter, so it is lifted out here rather than every caller
    # learning a second shape.
    system = "\n\n".join(
        str(m.get("content") or "") for m in messages if m.get("role") == "system"
    )
    turns = [
        {"role": m["role"], "content": str(m.get("content") or "")}
        for m in messages
        if m.get("role") in ("user", "assistant")
    ]
    if not turns:
        return None

    client = anthropic.Anthropic(api_key=key, timeout=float(timeout))
    response = client.messages.create(
        model="claude-opus-5",
        max_tokens=_REASONING_MAX_TOKENS,
        system=system or anthropic.NOT_GIVEN,
        messages=turns,
        # Thinking is on by default on this model and is left on: the documented
        # failure mode of disabling it is reasoning leaking into the visible
        # answer, which for a caller that parses the answer as JSON is a broken
        # response rather than a verbose one. Low effort is the cheap lever.
        output_config={"effort": "low"},
    )

    # Only the text blocks. A response can also carry thinking blocks, and
    # concatenating those into the answer would hand `_extract_json` a document
    # with prose wrapped around the JSON it is looking for.
    parts = [block.text for block in response.content if block.type == "text"]
    text = "".join(parts).strip()
    return text or None


PROVIDERS: list[Provider] = [
    Provider("groq-gpt-oss-20b", _groq_gptoss20, "GROQ_API_KEY", "groq"),
    Provider("cerebras-gpt-oss-120b", _cerebras_gptoss, "CEREBRAS_API_KEY", "cerebras"),
    Provider("mistral-small", _mistral, "MISTRAL_API_KEY", "mistral"),
    Provider("groq-gpt-oss-120b", _groq_gptoss, "GROQ_API_KEY", "groq"),
    Provider("gemini-3.6-flash", _gemini, "GEMINI_API_KEY", "gemini"),
    Provider("xai-grok", _xai, "XAI_API_KEY", "xai"),
    # Free but rationed, and therefore ordered after the uncapped free tiers
    # whatever this list says — see `metered` above. Two models on one backend:
    # `_select_providers` takes one provider per backend on its first pass, so
    # the pair is depth for when the ensemble needs more than one, not two slots
    # out of the daily allowance on every call.
    Provider("openrouter-gemma-4-26b", _openrouter("google/gemma-4-26b-a4b-it:free"),
             "OPENROUTER_API_KEY", "openrouter", metered=True),
    Provider("openrouter-nemotron-3-super-120b", _openrouter("nvidia/nemotron-3-super-120b-a12b:free"),
             "OPENROUTER_API_KEY", "openrouter", metered=True),
    # Paid, and therefore last whatever this list says — see `paid` above.
    #
    # The cheap one first. Same key as the free OpenRouter slots; this is the
    # PAID id (no :free suffix), so it only ever answers on an account with
    # credits — creditless, it 402s and the ensemble moves on, which is
    # today's behaviour exactly. The model is the same family the Groq
    # primary runs every day, so its clean-JSON output is proven in this
    # product rather than assumed — chosen off the live catalogue on
    # 21 Aug 2026 at $0.03/M in, $0.17/M out: a full rewrite lands around a
    # twentieth of a rupee. Routed by OpenRouter across hosts independent of
    # Groq's free tier, so the two do not rate-limit together. A $10 top-up
    # also lifts the :free slots above from 50 to 1000 requests/day — the
    # top-up pays for itself in free-tier depth before a single paid token.
    Provider("openrouter-paid-gpt-oss-120b", _openrouter("openai/gpt-oss-120b"),
             "OPENROUTER_API_KEY", "openrouter-paid", paid=True),
    Provider("claude-opus-5", _anthropic, "ANTHROPIC_API_KEY", "anthropic", paid=True),
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
    # Free first, always. Within each group the order in PROVIDERS is preserved,
    # so this changes nothing on a deployment with no paid key set — and on one
    # that has a key, the paid provider is reached only when the free tiers
    # cannot fill the request.
    # Uncapped free, then capped free, then paid. Tuple ordering does the work:
    # (False, False) < (False, True) < (True, False).
    candidates = sorted(candidates, key=lambda provider: (provider.paid, provider.metered))
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
