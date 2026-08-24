"""The model-answer cache.

The rest of the suite runs with this switched off (see conftest), so everything
here turns it back on explicitly. The assertions that matter are not "does it
store a value" — they are about the two things a cache in front of a flaky free
tier gets wrong: caching a bad day, and serving one user's answer to a question
nobody asked.
"""
from __future__ import annotations

import os
import time

import pytest

import company_research
import jobspec
import llm_cache
import resume_ai


@pytest.fixture
def cache_on(tmp_path, monkeypatch):
    """Turn the cache back on, into a directory of this test's own.

    Env vars are enough because llm_cache reads its configuration at call time.
    It did not always: the constants were module-level, so the documented off
    switch was evaluated once at import — before anything could set it — and the
    conftest fixture that disables the cache for the rest of the suite silently
    did nothing while appearing to work. These tests were what surfaced it.
    """
    monkeypatch.setenv("GRINDLY_LLM_CACHE", "1")
    monkeypatch.setenv("GRINDLY_LLM_CACHE_DIR", str(tmp_path / "cache"))
    return tmp_path / "cache"


# ---------------------------------------------------------------------------
# the primitive
# ---------------------------------------------------------------------------

def test_a_stored_value_comes_back(cache_on):
    key = llm_cache.key("kind", "input")
    llm_cache.put(key, {"a": 1})
    assert llm_cache.get(key) == {"a": 1}


def test_a_miss_is_none_rather_than_an_error(cache_on):
    assert llm_cache.get(llm_cache.key("kind", "never stored")) is None


def test_kinds_do_not_collide(cache_on):
    """A resume cached as a structure must never be served to a request for
    advice about the same text."""
    assert llm_cache.key("struct", "same text") != llm_cache.key("advice", "same text")


def test_no_user_text_is_written_into_a_filename(cache_on):
    """The key is a hash. A directory listing must not be a list of what people
    uploaded."""
    key = llm_cache.key("advice", "Priya Sharma, priya@example.com, Freshworks")
    llm_cache.put(key, {"ok": True})
    names = os.listdir(cache_on)
    assert names
    for name in names:
        assert "priya" not in name.lower()
        assert "freshworks" not in name.lower()


def test_an_expired_entry_is_not_served(cache_on, monkeypatch):
    key = llm_cache.key("kind", "input")
    llm_cache.put(key, "old")
    monkeypatch.setenv("GRINDLY_LLM_CACHE_TTL", "60")
    monkeypatch.setattr(llm_cache, "_ttl_seconds", lambda: -1)
    assert llm_cache.get(key) is None


def test_a_corrupt_entry_reads_as_a_miss(cache_on):
    """A process killed mid-write, or a half-copied volume. A cache that raises
    is worse than no cache."""
    key = llm_cache.key("kind", "input")
    llm_cache.put(key, "value")
    with open(os.path.join(str(cache_on), f"{key}.json"), "w", encoding="utf-8") as f:
        f.write("{not json")
    assert llm_cache.get(key) is None


def test_writing_to_an_unwritable_directory_does_not_raise(monkeypatch, tmp_path):
    monkeypatch.setenv("GRINDLY_LLM_CACHE", "1")
    monkeypatch.setenv("GRINDLY_LLM_CACHE_DIR", str(tmp_path / "file" / "nested"))
    (tmp_path / "file").write_text("I am a file, not a directory")
    llm_cache.put(llm_cache.key("kind", "x"), {"a": 1})  # must not raise


def test_disabled_means_disabled(tmp_path, monkeypatch):
    """The off switch, which for a while did not work at all."""
    monkeypatch.setenv("GRINDLY_LLM_CACHE", "0")
    monkeypatch.setenv("GRINDLY_LLM_CACHE_DIR", str(tmp_path / "cache"))
    key = llm_cache.key("kind", "input")
    llm_cache.put(key, "value")
    assert llm_cache.get(key) is None


def test_cached_does_not_store_an_empty_answer(cache_on):
    """An empty answer is what a rate-limited provider returns. Caching it turns
    one bad minute into a week of them."""
    calls = []

    def produce():
        calls.append(1)
        return None

    llm_cache.cached("kind", ["input"], produce)
    llm_cache.cached("kind", ["input"], produce)
    assert len(calls) == 2


def test_cached_calls_produce_once_for_a_real_answer(cache_on):
    calls = []

    def produce():
        calls.append(1)
        return {"value": len(calls)}

    first = llm_cache.cached("kind", ["input"], produce)
    second = llm_cache.cached("kind", ["input"], produce)
    assert first == second
    assert len(calls) == 1


def test_the_sweep_bounds_the_directory(cache_on, monkeypatch):
    monkeypatch.setattr(llm_cache, "_max_entries", lambda: 5)
    for i in range(12):
        llm_cache.put(llm_cache.key("kind", i), {"i": i})
        # Distinct mtimes, so "oldest first" means something on a filesystem
        # with coarse timestamps.
        time.sleep(0.01)
    assert len(os.listdir(cache_on)) <= 5


# ---------------------------------------------------------------------------
# the call sites, and what they refuse to cache
# ---------------------------------------------------------------------------

def test_a_parsed_job_description_is_reused(cache_on, monkeypatch):
    calls = []

    def fake(text, use_llm=True):
        calls.append(text)
        return {"title": "Backend Engineer", "company": "", "must_have": [],
                "nice_to_have": [], "skills": ["Python"], "source_chars": len(text),
                "llm_added": []}

    monkeypatch.setattr(jobspec, "_parse_uncached", fake)
    jobspec.parse("a long job description about python")
    jobspec.parse("a long job description about python")
    assert len(calls) == 1


def test_a_job_description_with_no_requirements_is_not_cached(cache_on, monkeypatch):
    """That shape is both "there is nothing in this text" and "no provider
    answered", and the two are indistinguishable here."""
    calls = []

    def fake(text, use_llm=True):
        calls.append(text)
        return {"title": "", "company": "", "must_have": [], "nice_to_have": [],
                "skills": [], "source_chars": 0, "llm_added": []}

    monkeypatch.setattr(jobspec, "_parse_uncached", fake)
    jobspec.parse("some text")
    jobspec.parse("some text")
    assert len(calls) == 2


def test_a_generated_company_pack_is_reused(cache_on, monkeypatch):
    calls = []

    def fake(name, role_hint=""):
        calls.append(name)
        return {"ok": True, "tailoring": "generated", "name": name,
                "keywords": ["Java"], "emphasis": ["Ships fast"], "summary": "",
                "confidence": 0.8, "disclaimer": ""}

    monkeypatch.setattr(company_research, "_research_uncached", fake)
    company_research.research("Freshworks")
    company_research.research("Freshworks")
    assert len(calls) == 1


def test_a_declined_company_is_not_cached(cache_on, monkeypatch):
    """`not_required` is the right answer for most employers AND the answer an
    outage produces. Right in the moment, wrong to keep for a week."""
    calls = []

    def fake(name, role_hint=""):
        calls.append(name)
        return {"ok": True, "tailoring": "not_required", "name": name,
                "keywords": [], "emphasis": [], "note": "", "disclaimer": ""}

    monkeypatch.setattr(company_research, "_research_uncached", fake)
    company_research.research("Some Startup")
    company_research.research("Some Startup")
    assert len(calls) == 2


def test_a_curated_pack_is_never_cached(cache_on, monkeypatch):
    """It is read from companies.py on disk, costs nothing, and editing a pack
    should reach users on the next request rather than in a week."""
    calls = []

    def fake(name, role_hint=""):
        calls.append(name)
        return {"ok": True, "tailoring": "curated", "name": name, "slug": "amazon",
                "keywords": ["Ownership"], "emphasis": ["16 LPs"], "disclaimer": ""}

    monkeypatch.setattr(company_research, "_research_uncached", fake)
    company_research.research("Amazon")
    company_research.research("Amazon")
    assert len(calls) == 2


def test_advice_is_never_cached(cache_on, monkeypatch):
    """`_advise_uncached` always returns a well-formed dict, filling it from a
    heuristic when no provider answers — so nothing in the shape distinguishes
    a real review from an outage, and a cache would serve the outage for a
    week under a panel titled "A recruiter's read"."""
    calls = []

    def fake(text):
        calls.append(text)
        return {"strengths": ["a"], "issues": [], "suggestions": []}

    monkeypatch.setattr(resume_ai, "_advise_uncached", fake)
    resume_ai.advise("a resume with enough text in it to be worth reviewing")
    resume_ai.advise("a resume with enough text in it to be worth reviewing")
    assert len(calls) == 2


def test_the_completion_budget_fits_a_whole_resume():
    """The rewrite and extraction calls return an ENTIRE resume as JSON. At the
    old 2048-token cap the complete, honest answers were cut off mid-JSON and
    discarded; the only survivor was whichever model had compressed the resume
    enough to fit, which the content-loss gate then rejected — a targeted run
    produced nothing at all for an ordinary 3,500-character resume. Seen live.
    """
    import llm
    assert llm._DEFAULT_MAX_TOKENS >= 4096


def test_groq_requests_fit_its_free_tier_limit():
    """Groq rejects a request with HTTP 413 when prompt + max_tokens exceed its
    per-minute allowance, BEFORE generating anything. Raising the global cap
    to 8192 switched Groq off for every call (seen live). The budget must fit
    under the limit for an ordinary prompt, shrink for a long one, and skip
    Groq entirely when the prompt alone leaves no room.
    """
    import llm
    small = [{"role": "user", "content": "x" * 4000}]
    big = [{"role": "user", "content": "x" * 20000}]
    huge = [{"role": "user", "content": "x" * 40000}]
    assert 1024 <= llm._groq_budget(small) <= llm._DEFAULT_MAX_TOKENS
    assert llm._groq_budget(small) + 4000 // llm._GROQ_CHARS_PER_TOKEN + 64 <= llm._GROQ_REQUEST_TOKENS
    assert 1024 <= llm._groq_budget(big) < llm._groq_budget(small)
    assert llm._groq_budget(huge) is None
    # The live 413: a prompt at the text slice (24k chars) is ~7k real tokens,
    # not the ~6k a chars/4 estimate gave — with a 1.9k budget on top it
    # crossed the limit. Estimated conservatively it leaves no room and Groq is
    # skipped, which is the honest outcome; the ensemble carries on without it.
    at_slice = [{"role": "user", "content": "x" * 24000}]
    assert llm._groq_budget(at_slice) is None
    # And the ratio really is the conservative side of what resume text and
    # JSON tokenize at (~3.3-3.6 chars/token).
    assert llm._GROQ_CHARS_PER_TOKEN <= 3
    # One ordinary call must not reserve the whole 8000-token minute: Groq
    # counts prompt + max_tokens against it, and "all the room" meant the
    # second call of the same run answered 429. Seen live, self-inflicted.
    assert llm._groq_budget(small) + 4000 // llm._GROQ_CHARS_PER_TOKEN + 64 <= llm._GROQ_REQUEST_TOKENS // 2
    # ...while still leaving a whole answer's worth for a short prompt.
    assert llm._groq_budget(small) >= llm._GROQ_ANSWER_FLOOR


def test_provider_health_survives_the_process(tmp_path, monkeypatch):
    """Node spawns a fresh interpreter per command, so a breaker held in memory
    never opened for anyone. It lives in a file now: a 429 recorded by one
    process is an open circuit in the next one, and a success closes it."""
    import importlib
    import llm
    path = tmp_path / "llm-health.json"
    monkeypatch.setenv("GRINDLY_LLM_HEALTH_FILE", str(path))
    llm = importlib.reload(llm)
    provider = llm.PROVIDERS[0]
    assert not llm._circuit_open(provider)
    # A 429 with Retry-After opens the circuit at once, for at least that long.
    llm._record_provider_result(provider, ok=False, rate_limited_for=30.0)
    assert llm._circuit_open(provider)
    assert path.exists()
    # A "new process": fresh module state, same file.
    llm = importlib.reload(llm)
    assert llm._circuit_open(provider), "the breaker did not survive the process"
    # Expired holds close by themselves; a success closes one outright.
    llm._record_provider_result(provider, ok=True)
    assert not llm._circuit_open(provider)
    llm = importlib.reload(llm)
    assert not llm._circuit_open(provider)
    # The file is advisory: a corrupt one is an empty breaker, never an error.
    path.write_text("{not json", encoding="utf-8")
    llm = importlib.reload(llm)
    assert not llm._circuit_open(provider)
    llm._record_provider_result(provider, ok=False)
    assert path.read_text(encoding="utf-8").startswith("{")


def test_retries_are_bounded_by_the_call_timeout(monkeypatch):
    """`timeout` bounds the whole call, retries included. Three attempts at the
    full timeout each answered after the Node side had already killed the
    command — wasted work with a confusing message."""
    import io
    import urllib.error
    import urllib.request
    import llm
    calls = []
    clock = {"now": 1000.0}
    monkeypatch.setattr(llm.time, "monotonic", lambda: clock["now"])
    monkeypatch.setattr(llm.time, "sleep", lambda s: clock.__setitem__("now", clock["now"] + s))

    def hang(req, timeout):
        calls.append(timeout)
        clock["now"] += timeout  # the request used its whole allowance
        raise urllib.error.HTTPError(req.full_url, 503, "Unavailable", {}, io.BytesIO(b""))

    monkeypatch.setattr(llm.urllib.request, "urlopen", hang)
    req = urllib.request.Request("https://api.example.test/v1/chat/completions", data=b"{}")
    try:
        llm._urlopen_json(req, timeout=20)
    except urllib.error.HTTPError:
        pass
    else:
        raise AssertionError("a failing request must raise")
    # One attempt used the budget; no second attempt started past it.
    assert len(calls) == 1, calls
    assert calls[0] == 20

    # A metered host is not retried on 429: that allowance is per DAY.
    calls.clear()

    def limited(req, timeout):
        calls.append(timeout)
        raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, io.BytesIO(b""))

    monkeypatch.setattr(llm.urllib.request, "urlopen", limited)
    req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions", data=b"{}")
    try:
        llm._urlopen_json(req, timeout=60)
    except urllib.error.HTTPError as e:
        assert e.code == 429
    assert len(calls) == 1, "a metered 429 was retried"
    # ...while an uncapped host still gets its retries within the budget.
    calls.clear()
    req = urllib.request.Request("https://api.groq.com/openai/v1/chat/completions", data=b"{}")
    try:
        llm._urlopen_json(req, timeout=60)
    except urllib.error.HTTPError:
        pass
    assert len(calls) == llm._MAX_RETRIES
    # And the breaker can read what the last request ended with.
    assert llm._last_http.code == 429


def test_a_whole_chain_failure_is_said_in_the_lifted_form(monkeypatch, capsys):
    """Single 429s stay out of the admin table on purpose. A request that got
    nothing from ANY provider is the outage itself and must reach it — so it is
    printed in the one form lib/agent.ts lifts: `[llm] <who> error: <why>`."""
    import llm
    monkeypatch.setenv("GRINDLY_LLM_HEALTH_FILE", "")
    providers = [llm.Provider("dead-a", lambda *a, **k: None, "K", "a"),
                 llm.Provider("dead-b", lambda *a, **k: None, "K", "b")]
    monkeypatch.setenv("K", "x")
    monkeypatch.setattr(llm, "PROVIDERS", providers)
    monkeypatch.setattr(llm, "_save_health", lambda: None)
    assert llm.chat_ensemble("hi", n=2, timeout=5) == []
    assert llm.chat("hi", timeout=5) is None
    out = capsys.readouterr().out
    import re as _re
    lifted = _re.compile(r"^\[llm\]\s+(.*?)\s+error:\s+(.*)$", _re.M)
    found = [m.group(0) for m in lifted.finditer(out)]
    assert any("ensemble error: all 2 providers failed" in line for line in found), out
    assert any("chain error: all 2 providers failed" in line for line in found), out


def test_http_errors_carry_the_provider_body():
    """`HTTP Error 413: Payload Too Large` says nothing; the body says
    "Limit 8000, Requested 8412". The printed error line is the only place a
    provider failure is observable, so the body belongs in it — once, bounded,
    whitespace collapsed, and never raising if the body cannot be read."""
    import io
    import urllib.error
    import llm
    body = b'{"error": {"message": "Request too large for model.\n  Limit 8000, Requested 8412"}}'
    err = urllib.error.HTTPError("https://x", 413, "Payload Too Large", {}, io.BytesIO(body))
    out = llm._annotate_http_error(err)
    assert out is err
    assert "HTTP Error 413: Payload Too Large — " in str(out)
    assert "Limit 8000, Requested 8412" in str(out)
    assert "\n" not in str(out)
    # Bounded: a huge body does not become a huge log line.
    big = urllib.error.HTTPError("https://x", 429, "Too Many Requests", {}, io.BytesIO(b"y" * 5000))
    assert len(str(llm._annotate_http_error(big))) < 300
    # Unreadable body: message unchanged, no exception.
    none = urllib.error.HTTPError("https://x", 500, "Server Error", {}, None)
    assert str(llm._annotate_http_error(none)) == "HTTP Error 500: Server Error"
