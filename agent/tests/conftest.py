"""Test isolation for the two files the agent writes as side effects.

The LLM cache and the provider-health breaker both persist under `data/` so
they survive a process (that is their point). Left alone in tests, one test's
cached extraction or opened circuit would leak into the next — and into the
repo's real `data/` directory. Each test gets its own throwaway pair; tests
that want a specific location still set the variables themselves.
"""
import pytest


@pytest.fixture(autouse=True)
def _isolated_agent_state(tmp_path, monkeypatch):
    monkeypatch.setenv("GRINDLY_LLM_CACHE_DIR", str(tmp_path / "llm-cache"))
    monkeypatch.setenv("GRINDLY_LLM_HEALTH_FILE", str(tmp_path / "llm-health.json"))
    # The breaker is loaded once per process; make each test start empty.
    try:
        import llm
        with llm._health_lock:
            llm._provider_health.clear()
            llm._health_loaded = False
    except Exception:  # noqa: BLE001 — a test that never imports llm does not care
        pass
    yield
