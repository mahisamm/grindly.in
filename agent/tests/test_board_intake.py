"""Thousands of new boards must arrive as a trickle, not a flood.

The tenant enumerator changed the shape of this problem. It hands over
thousands of tenants in one sweep — 7,575 across six vendors, measured, against
574 previously known — and every one of them is exempt from cold backoff by
design, because an unknown board is not a cold board and a freshly harvested
company should not wait days for its first look.

That rule is right at a trickle and catastrophic at a flood: the next run would
open seven thousand connections at once, on a 1 vCPU box whose sweep container
is capped at 384 MB.
"""
import atsboards


def test_a_board_nobody_has_polled_is_recognised_as_new(monkeypatch):
    monkeypatch.setattr(atsboards, "_STATS", {}, raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)
    assert atsboards._never_polled("keka", "convertcart") is True


def test_a_board_that_has_been_polled_is_not_new(monkeypatch):
    monkeypatch.setattr(atsboards, "_STATS",
                        {"keka::convertcart": {"yields": 0, "cold_streak": 3}}, raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)
    assert atsboards._never_polled("keka", "convertcart") is False


def test_a_cold_board_is_still_re_asked_eventually(monkeypatch):
    """The two budgets are separate on purpose: re-asking a cold board is cheap
    and self-limiting, while a first look is what the enumerator produces
    thousands of at once. Rationing first looks must not stop the backoff cycle
    from ever coming back round."""
    monkeypatch.setattr(atsboards, "_STATS",
                        {"keka::acme": {"yields": 0, "cold_streak": 1, "skips": 0}},
                        raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)
    assert atsboards._poll_due("keka", "acme") is True


def test_a_board_that_has_produced_an_internship_is_never_skipped(monkeypatch):
    monkeypatch.setattr(atsboards, "_STATS",
                        {"keka::acme": {"yields": 4, "cold_streak": 30}}, raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)
    assert atsboards._poll_due("keka", "acme") is True


def test_the_first_look_budget_is_small_enough_for_one_cpu():
    """Sized against the real box: 1 vCPU, sweep capped at 384 MB, eight
    concurrent fetchers. A few hundred is a run; a few thousand is an outage."""
    assert 20 <= atsboards.NEW_BOARDS_PER_RUN <= 500


def test_the_learned_cap_is_above_what_one_enumeration_produces():
    """Measured: 7,575 tenants from six vendors in one sweep. A cap below that
    would throw most of a successful enumeration away on the spot."""
    assert atsboards.LEARNED_MAX >= 8000


# ── the trim keeps what works, not what sorts first ───────────────────────

def test_the_trim_keeps_boards_that_have_found_internships(monkeypatch, tmp_path):
    """The old trim was a plain alphabetical sort — its own comment conceded it
    was "deterministic rather than a policy". It is a bad one: the moment the
    cap binds it discards boards from the end of the alphabet regardless of
    whether those are the ones producing internships. With the enumerator able
    to add thousands at once, the cap now binds."""
    monkeypatch.setattr(atsboards, "_LEARNED_FILE", str(tmp_path / "slugs.json"), raising=False)
    monkeypatch.setattr(atsboards, "_LEARNED", set(), raising=False)
    monkeypatch.setattr(atsboards, "_learned_loaded", True, raising=False)
    monkeypatch.setattr(atsboards, "LEARNED_MAX", 2, raising=False)
    # zzz has produced internships; aaa and bbb never have.
    monkeypatch.setattr(atsboards, "_STATS", {
        "keka::zzzproductive": {"yields": 7},
        "keka::aaacold": {"yields": 0, "cold_streak": 9},
    }, raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)

    atsboards.remember_slugs([
        "https://zzzproductive.keka.com/careers/",
        "https://aaacold.keka.com/careers/",
        "https://bbbunknown.keka.com/careers/",
    ])

    kept = {slug for _v, slug in atsboards._LEARNED}
    assert "zzzproductive" in kept, "the trim dropped a board that finds internships"
    assert len(kept) == 2


def test_a_polled_board_outranks_one_never_looked_at(monkeypatch, tmp_path):
    monkeypatch.setattr(atsboards, "_LEARNED_FILE", str(tmp_path / "slugs.json"), raising=False)
    monkeypatch.setattr(atsboards, "_LEARNED", set(), raising=False)
    monkeypatch.setattr(atsboards, "_learned_loaded", True, raising=False)
    monkeypatch.setattr(atsboards, "LEARNED_MAX", 1, raising=False)
    monkeypatch.setattr(atsboards, "_STATS",
                        {"keka::zzzknown": {"yields": 0, "cold_streak": 2}}, raising=False)
    monkeypatch.setattr(atsboards, "_stats_loaded", True, raising=False)

    atsboards.remember_slugs([
        "https://zzzknown.keka.com/careers/",
        "https://aaaunknown.keka.com/careers/",
    ])
    assert {slug for _v, slug in atsboards._LEARNED} == {"zzzknown"}


def test_the_trim_does_not_run_when_the_cap_is_not_reached(monkeypatch, tmp_path):
    monkeypatch.setattr(atsboards, "_LEARNED_FILE", str(tmp_path / "slugs.json"), raising=False)
    monkeypatch.setattr(atsboards, "_LEARNED", set(), raising=False)
    monkeypatch.setattr(atsboards, "_learned_loaded", True, raising=False)
    monkeypatch.setattr(atsboards, "LEARNED_MAX", 5000, raising=False)

    atsboards.remember_slugs([
        "https://one.keka.com/careers/", "https://two.keka.com/careers/",
    ])
    assert {slug for _v, slug in atsboards._LEARNED} == {"one", "two"}
