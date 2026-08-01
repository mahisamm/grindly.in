"""The search cache must serve the fleet, not just rescue a failure.

Measured: the cache was consulted ONLY after the provider returned empty, so it
saved nothing on the happy path. Every user's run re-issued the same ~162
searches, and the harvest terms are role-independent by design — so at 1000
users that was ~162,000 upstream queries a day, from one IP, for a few hundred
distinct answers. That is the surest way to get the IP throttled and take the
only working discovery path down with it.
"""
import time
from unittest.mock import patch

import websearch


def _reset(entries=None):
    websearch._CACHE.clear()
    websearch._loaded = True          # never touch the real file from a test
    if entries:
        websearch._CACHE.update(entries)


def test_a_fresh_answer_is_served_without_asking_upstream():
    key = f"{websearch.provider()}::python intern::10"
    _reset({key: (time.time(), [{"url": "https://example.test/a"}])})
    with patch.object(websearch, "configured", return_value=True), \
         patch.dict(websearch.__dict__, {}, clear=False), \
         patch.object(websearch, "_save_cache", lambda: None):
        called = {"n": 0}

        def _provider(q, n):
            called["n"] += 1
            return [{"url": "https://example.test/live"}]

        with patch.dict(globals(), {}, clear=False), \
             patch.object(websearch, "_PROVIDERS", {websearch.provider(): "_spy"}):
            websearch._spy = _provider   # type: ignore[attr-defined]
            out = websearch.search("python intern", 10)

    assert out == [{"url": "https://example.test/a"}]
    assert called["n"] == 0, "upstream was queried despite a fresh cached answer"


def test_a_miss_still_reaches_upstream():
    _reset()
    with patch.object(websearch, "configured", return_value=True), \
         patch.object(websearch, "_save_cache", lambda: None), \
         patch.object(websearch, "_PROVIDERS", {websearch.provider(): "_spy"}):
        websearch._spy = lambda q, n: [{"url": "https://example.test/new"}]  # type: ignore[attr-defined]
        out = websearch.search("something nobody asked", 10)
    assert out == [{"url": "https://example.test/new"}]


def test_a_stale_answer_still_rescues_a_throttled_provider():
    """The original purpose survives: when upstream says nothing, a stale
    answer beats reporting no work."""
    key = f"{websearch.provider()}::react intern::10"
    _reset({key: (time.time() - websearch.CACHE_TTL - 60, [{"url": "https://example.test/old"}])})
    with patch.object(websearch, "configured", return_value=True), \
         patch.object(websearch, "_save_cache", lambda: None), \
         patch.object(websearch, "_PROVIDERS", {websearch.provider(): "_spy"}):
        websearch._spy = lambda q, n: []  # type: ignore[attr-defined]
        out = websearch.search("react intern", 10)
    assert out == [{"url": "https://example.test/old"}]


def test_a_stale_read_does_not_delete_the_entry():
    """The next throttled run wants it too."""
    key = "k"
    _reset({key: (time.time() - websearch.CACHE_TTL - 60, [{"url": "u"}])})
    assert websearch._cache_get(key, allow_stale=True)
    assert key in websearch._CACHE


def test_a_stale_entry_is_not_served_to_the_fresh_reader():
    key = "k"
    _reset({key: (time.time() - websearch.CACHE_TTL - 60, [{"url": "u"}])})
    assert websearch._cache_get(key) is None


# --- and the file cannot grow without limit ---------------------------------

def test_expired_entries_are_dropped_on_save(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(websearch, "_CACHE_FILE", str(tmp_path / "search_cache.json"))
    _reset({
        "old": (time.time() - websearch.CACHE_TTL - 60, [{"url": "stale"}]),
        "new": (time.time(), [{"url": "fresh"}]),
    })
    websearch._save_cache()
    on_disk = json.loads((tmp_path / "search_cache.json").read_text())
    assert "new" in on_disk
    assert "old" not in on_disk


def test_the_file_is_capped(tmp_path, monkeypatch):
    import json

    monkeypatch.setattr(websearch, "_CACHE_FILE", str(tmp_path / "search_cache.json"))
    now = time.time()
    _reset({f"q{i}": (now - i, [{"url": f"u{i}"}]) for i in range(websearch._CACHE_MAX + 250)})
    websearch._save_cache()
    on_disk = json.loads((tmp_path / "search_cache.json").read_text())
    assert len(on_disk) <= websearch._CACHE_MAX
    assert "q0" in on_disk, "the newest entry was trimmed"
