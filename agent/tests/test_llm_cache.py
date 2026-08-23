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
