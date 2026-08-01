"""The board index must survive two workers writing at once.

This is not hypothetical. It happened in production today: two harvest
processes ran concurrently, both wrote the learned-board list, and the result
was 215 KB of JSON that stops parsing at character 98,261. An 8,469-board index
— the entire output of the tenant enumeration — became zero boards.

The rename was atomic. The WRITE was not: both processes opened the same fixed
`ats_slugs.json.tmp`, interleaved into it, and each renamed the mangled result
over the real file. `_save_stats` had always used mkstemp; this path never did.

And the failure was silent. One line — "learned-slug load skipped:
JSONDecodeError" — in a harvest log, after which discovery ran against the
hardcoded list and looked like it was working.
"""
import json
import os

import pytest

import atsboards


@pytest.fixture()
def index(tmp_path, monkeypatch):
    path = str(tmp_path / "ats_slugs.json")
    monkeypatch.setattr(atsboards, "_LEARNED_FILE", path, raising=False)
    monkeypatch.setattr(atsboards, "_LEARNED", set(), raising=False)
    monkeypatch.setattr(atsboards, "_learned_loaded", True, raising=False)
    monkeypatch.setattr(atsboards, "_STATS", {}, raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)
    return path


def test_the_temp_file_is_unique_per_writer(index, monkeypatch):
    """The actual bug. A fixed temp name means two concurrent writers share one
    buffer on disk, and the atomic rename that follows only guarantees the
    mangled bytes land in one piece."""
    seen = []
    real = atsboards.tempfile.mkstemp

    def spy(*a, **k):
        fd, path = real(*a, **k)
        seen.append(path)
        return fd, path

    monkeypatch.setattr(atsboards.tempfile, "mkstemp", spy)
    atsboards.remember_slugs(["https://one.keka.com/careers/"])
    atsboards.remember_slugs(["https://two.keka.com/careers/"])

    assert len(seen) == 2
    assert seen[0] != seen[1], "two writers shared one temp path — the bug"
    assert not os.path.exists(index + ".tmp"), "still using a fixed temp name"


def test_what_was_written_is_readable_json(index):
    atsboards.remember_slugs([
        "https://convertcart.keka.com/careers/",
        "https://codingal.keka.com/careers/",
    ])
    with open(index, encoding="utf-8") as f:
        assert len(json.load(f)) == 2


def test_a_corrupt_index_is_reported_loudly_not_swallowed(index, capsys, monkeypatch):
    """It failed silently for a whole harvest. One quiet line, and then
    discovery ran against the hardcoded list looking perfectly healthy."""
    with open(index, "w", encoding="utf-8") as f:
        f.write('[["keka", "one"], ["keka", "tw')   # truncated mid-write

    monkeypatch.setattr(atsboards, "_learned_loaded", False, raising=False)
    atsboards._load_learned()

    said = capsys.readouterr().out
    assert "CORRUPT" in said
    assert "tenants.py" in said, "the message must say how to rebuild the index"


def test_a_corrupt_index_is_kept_for_recovery(index, monkeypatch):
    """Renaming it makes the loss recoverable and stops the next save from
    quietly overwriting the evidence."""
    with open(index, "w", encoding="utf-8") as f:
        f.write("not json at all")

    monkeypatch.setattr(atsboards, "_learned_loaded", False, raising=False)
    atsboards._load_learned()

    assert os.path.exists(index + ".corrupt")
    assert not os.path.exists(index)


def test_a_corrupt_index_does_not_stop_the_run(index, monkeypatch):
    """Discovery still has its hardcoded spine. Losing the learned list is bad,
    but crashing every user's run over it would be worse."""
    with open(index, "w", encoding="utf-8") as f:
        f.write("{{{")

    monkeypatch.setattr(atsboards, "_learned_loaded", False, raising=False)
    atsboards._load_learned()
    assert atsboards._LEARNED == set()


def test_a_missing_index_is_ordinary_and_silent(index, capsys, monkeypatch):
    """A fresh install has no file. That is not corruption and must not shout."""
    monkeypatch.setattr(atsboards, "_learned_loaded", False, raising=False)
    atsboards._load_learned()
    assert "CORRUPT" not in capsys.readouterr().out
