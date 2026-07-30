"""Regression tests for concurrent discovery-cache persistence."""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import atsboards
import websearch


def test_websearch_cache_saves_concurrently_without_shared_tmp_race(tmp_path, monkeypatch):
    # Regression: worker and sweep shared `search_cache.json.tmp`, so one could
    # atomically replace it while the other was still trying to do the same.
    # Found during production QA on 2026-07-30.
    monkeypatch.setattr(websearch, "_CACHE_FILE", str(tmp_path / "search_cache.json"))
    monkeypatch.setattr(websearch, "_CACHE", {"python": (1.0, [{"url": "https://example.test"}])})

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: websearch._save_cache(), range(32)))

    assert json.loads((tmp_path / "search_cache.json").read_text())["python"][1]


def test_ats_cache_saves_concurrently_without_shared_tmp_race(tmp_path, monkeypatch):
    # Regression: the shared ATS cache had the same fixed-temp-file race.
    monkeypatch.setattr(atsboards, "_CACHE_FILE", str(tmp_path / "ats_boards.json"))
    monkeypatch.setattr(atsboards, "_CACHE", {"greenhouse::acme": (1.0, {"jobs": []})})

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: atsboards._save_cache(), range(32)))

    assert json.loads((tmp_path / "ats_boards.json").read_text())["greenhouse::acme"][1]
