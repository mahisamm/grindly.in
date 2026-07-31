"""Boards earn their polling.

Every board costs one request per cache window, forever. That is fine at 400
boards and wasteful at 4000 — and the harvester validates ~69 new live boards
per sweep, so 4000 is where this is heading. Most boards have never produced a
single India internship: a measured sweep found ten across 391 Keka postings
and none at all across Greenhouse's 563.

The failure to guard against is over-eagerness: a company that hires interns in
September has none in July, and a board written off in July never comes back.
"""
import atsboards


def _reset():
    atsboards._STATS.clear()
    atsboards._stats_loaded = True  # never touch the real file from a test


def test_a_board_never_polled_before_is_always_due():
    """An unknown board is not a cold board. Treating it as one would make a
    freshly harvested company wait days for its first look."""
    _reset()
    assert atsboards._poll_due("keka", "brandnew")


def test_a_board_that_has_ever_yielded_is_always_due():
    """Those are the companies that hire interns. Missing a new posting there
    is the entire cost of being wrong."""
    _reset()
    atsboards.note_board_result("keka", "hot", 3)
    for _ in range(50):
        assert atsboards._poll_due("keka", "hot")


def test_a_cold_board_is_polled_less_often_but_never_dropped():
    _reset()
    for _ in range(6):
        atsboards.note_board_result("greenhouse", "cold", 0)
    polls = sum(1 for _ in range(64) if atsboards._poll_due("greenhouse", "cold"))
    assert polls > 0, "a cold board was dropped forever"
    assert polls < 64, "backoff never engaged"


def test_backoff_is_capped_so_a_cold_board_still_gets_checked():
    """September's internship must be findable even after a quiet summer."""
    _reset()
    for _ in range(40):
        atsboards.note_board_result("greenhouse", "verycold", 0)
    polls = sum(1 for _ in range(atsboards.COLD_BACKOFF_MAX * 3)
                if atsboards._poll_due("greenhouse", "verycold"))
    assert polls >= 2, f"only polled {polls} times in three backoff periods"


def test_one_yield_resets_the_cold_streak():
    _reset()
    for _ in range(10):
        atsboards.note_board_result("keka", "seasonal", 0)
    atsboards.note_board_result("keka", "seasonal", 1)
    for _ in range(20):
        assert atsboards._poll_due("keka", "seasonal")


def test_a_single_quiet_run_does_not_trigger_backoff():
    """Boards go quiet between postings constantly; one empty poll is noise."""
    _reset()
    atsboards.note_board_result("keka", "quiet", 0)
    assert atsboards._poll_due("keka", "quiet")


def test_the_hardcoded_boards_are_never_skipped(monkeypatch):
    """Each was verified by hand against its API and is the spine of the
    source. A quiet fortnight is not evidence Razorpay stopped hiring."""
    _reset()
    pinned = [(v, s) for v, slugs in atsboards.BOARDS.items() for s in slugs]
    vendor, slug = pinned[0]
    for _ in range(50):
        atsboards.note_board_result(vendor, slug, 0)

    seen = []
    monkeypatch.setattr(atsboards, "_board", lambda v, s: seen.append((v, s)) or None)
    monkeypatch.setattr(atsboards, "_slugs_seen_before", lambda: [])
    monkeypatch.setattr(atsboards, "_save_cache", lambda: None)
    monkeypatch.setattr(atsboards, "_save_stats", lambda: None)
    atsboards.fetch([], limit=5)
    assert (vendor, slug) in seen, "a hand-verified board was skipped by backoff"


def test_stats_survive_a_corrupt_file(monkeypatch, tmp_path):
    bad = tmp_path / "ats_board_stats.json"
    bad.write_text("{not json")
    monkeypatch.setattr(atsboards, "_STATS_FILE", str(bad))
    atsboards._STATS.clear()
    atsboards._stats_loaded = False
    atsboards._load_stats()
    assert atsboards._poll_due("keka", "anything")
