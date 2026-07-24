"""Tiered apply policy — who is allowed to submit what, unattended.

Every test here is a fail-closed test. The old policy was one boolean that
always said no; the new one says yes in exactly one situation (Tier A, live
mode) and must say no everywhere else, including when the configuration is
wrong, missing, or garbage.
"""
import pytest

import resolver
import safety


def _dest(tier, channel=resolver.CHANNEL_GOOGLE_FORM):
    return resolver.destination(
        channel=channel, tier=tier, target="https://example.test/form",
        vendor="google", evidence="test",
    )


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("GRINDLY_AUTO_APPLY_MODE", raising=False)
    monkeypatch.delenv("GRINDLY_TIER_B_APPLY", raising=False)


# ── The switch itself ───────────────────────────────────────────────────────

def test_default_mode_is_shadow_not_live():
    """Nothing sends until someone deliberately turns it on."""
    assert safety.auto_apply_mode() == safety.AUTO_APPLY_SHADOW


def test_an_unrecognised_mode_reads_as_shadow(monkeypatch):
    for junk in ("LIVE!", "true", "1", "yes", "", "   "):
        monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", junk)
        assert safety.auto_apply_mode() == safety.AUTO_APPLY_SHADOW


def test_mode_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "  LIVE ")
    assert safety.auto_apply_mode() == safety.AUTO_APPLY_LIVE


# ── Tier A ──────────────────────────────────────────────────────────────────

def test_tier_a_sends_only_in_live_mode(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    ok, _ = safety.destination_policy(_dest(resolver.TIER_A))
    assert ok is True


def test_tier_a_is_held_in_shadow_mode(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "shadow")
    ok, reason = safety.destination_policy(_dest(resolver.TIER_A))
    assert ok is False
    assert "shadow" in reason.lower()


def test_off_mode_holds_everything(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "off")
    for tier in (resolver.TIER_A, resolver.TIER_B, resolver.TIER_C):
        ok, _ = safety.destination_policy(_dest(tier))
        assert ok is False


# ── Tier B ──────────────────────────────────────────────────────────────────

def test_tier_b_needs_its_own_switch_on_top_of_live(monkeypatch):
    """Turning Tier A on must never silently turn on the one path that can cost
    a user their account."""
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    ok, reason = safety.destination_policy(_dest(resolver.TIER_B, resolver.CHANNEL_PLATFORM))
    assert ok is False
    assert reason

    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    ok, _ = safety.destination_policy(_dest(resolver.TIER_B, resolver.CHANNEL_PLATFORM))
    assert ok is True


def test_tier_b_switch_alone_does_nothing_in_shadow(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "shadow")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    ok, _ = safety.destination_policy(_dest(resolver.TIER_B, resolver.CHANNEL_PLATFORM))
    assert ok is False


# ── Tier C ──────────────────────────────────────────────────────────────────

def test_tier_c_is_never_sent_at_any_setting(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    ok, reason = safety.destination_policy(_dest(resolver.TIER_C, resolver.CHANNEL_PLATFORM))
    assert ok is False
    assert "own browser" in reason


# ── Junk input ──────────────────────────────────────────────────────────────

def test_missing_or_unknown_destination_is_refused(monkeypatch):
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    for dest in (None, {}, {"tier": "Z"}, {"channel": "google_form"}):
        ok, _ = safety.destination_policy(dest)
        assert ok is False


def test_tier_c_boards_never_submit_unattended_at_any_setting(monkeypatch):
    """The board gate stays a second lock for Tier C. Even with the fleet live
    and Tier B switched on — the most permissive configuration that exists —
    a board holding an account the user cannot afford to lose still says no,
    and so does any source we do not recognise."""
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    for source in ("linkedin", "naukri", "unstop", "indeed", "future_source", None):
        required, reason = safety.requires_manual_final_submit(source)
        assert required is True, source
        assert "own browser" in reason


def test_internshala_needs_both_switches_before_it_submits(monkeypatch):
    """Tier B is the one board that may be submitted for the user, because they
    handed over credentials through the hosted-login consent flow. It still
    needs live mode AND its own switch: either alone holds the application, so
    turning Tier A on can never silently start submitting under an account."""
    for mode, tier_b, manual_expected in (
        ("shadow", None, True),
        ("shadow", "1", True),
        ("live", None, True),
        ("off", "1", True),
        ("live", "1", False),
    ):
        monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", mode)
        if tier_b is None:
            monkeypatch.delenv("GRINDLY_TIER_B_APPLY", raising=False)
        else:
            monkeypatch.setenv("GRINDLY_TIER_B_APPLY", tier_b)
        required, _ = safety.requires_manual_final_submit("internshala")
        assert required is manual_expected, f"mode={mode!r} tier_b={tier_b!r}"
