"""The board cache must not grow without limit.

Measured in production: ats_boards.json reached 425 MB on a 49 GB VPS. The TTL
governed reads only — expired entries were dropped on load but written back on
save — and nothing ever bounded an individual board, whose raw payload is the
company's entire careers site (one Workable account returned 2,802 postings).
The board list grows on its own, so the file grew without limit by design.
"""
import json
import time

import atsboards


def _reset(entries: dict):
    atsboards._CACHE.clear()
    atsboards._CACHE.update(entries)


def test_expired_entries_are_dropped_on_save_not_only_on_load():
    """The missing half. A board polled once stayed in the file forever."""
    old = time.time() - atsboards.CACHE_TTL - 60
    _reset({"greenhouse::stale": (old, {"jobs": [1, 2, 3]}),
            "greenhouse::fresh": (time.time(), {"jobs": [4]})})
    out = atsboards._cache_for_disk()
    assert "greenhouse::stale" not in out
    assert "greenhouse::fresh" in out


def test_a_single_enormous_board_is_refused():
    big = {"jobs": [{"description": "x" * 5000} for _ in range(1000)]}
    assert len(json.dumps(big)) > atsboards.CACHE_MAX_BOARD_BYTES
    _reset({"workable::huge": (time.time(), big),
            "greenhouse::small": (time.time(), {"jobs": [1]})})
    out = atsboards._cache_for_disk()
    assert "workable::huge" not in out
    assert "greenhouse::small" in out, "the small board was punished for the big one"


def test_the_whole_file_stays_under_the_ceiling(monkeypatch):
    monkeypatch.setattr(atsboards, "CACHE_MAX_BYTES", 50_000)
    monkeypatch.setattr(atsboards, "CACHE_MAX_BOARD_BYTES", 20_000)
    now = time.time()
    _reset({f"greenhouse::b{i}": (now - i, {"jobs": ["y" * 400]})
            for i in range(200)})
    out = atsboards._cache_for_disk()
    assert len(json.dumps(out)) <= 50_000 * 1.05
    assert out, "the ceiling emptied the cache entirely"


def test_the_trim_keeps_the_newest_boards(monkeypatch):
    """A run is likeliest to reuse what it just fetched."""
    now = time.time()
    _reset({f"greenhouse::b{i}": (now - i * 100, {"jobs": [i]}) for i in range(10)})
    one_entry = len(json.dumps([now, {"jobs": [0]}]))
    monkeypatch.setattr(atsboards, "CACHE_MAX_BYTES", one_entry * 3)
    out = atsboards._cache_for_disk()
    assert "greenhouse::b0" in out, "the newest board was trimmed"
    assert "greenhouse::b9" not in out, "the oldest board survived the trim"


def test_an_unserialisable_payload_never_fails_the_save():
    _reset({"greenhouse::bad": (time.time(), {"jobs": {1, 2, 3}}),  # a set
            "greenhouse::good": (time.time(), {"jobs": [1]})})
    out = atsboards._cache_for_disk()
    assert "greenhouse::good" in out
    assert "greenhouse::bad" not in out


def test_an_empty_payload_is_not_cached():
    _reset({"greenhouse::empty": (time.time(), None),
            "greenhouse::real": (time.time(), {"jobs": [1]})})
    out = atsboards._cache_for_disk()
    assert "greenhouse::empty" not in out
    assert "greenhouse::real" in out


def test_saving_an_empty_cache_is_harmless():
    _reset({})
    assert atsboards._cache_for_disk() == {}
