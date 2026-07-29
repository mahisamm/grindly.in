"""The user's own daily limit — stored, shown, and now actually obeyed.

`profile.max_per_day` was collected at signup, accepted by /api/profile and read
by nothing: every run took its ceiling straight from the plan. A setting the
product stores, displays and ignores is worse than one it never offered, so
these pin the rule that replaced it.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import worker


def _cap(monkeypatch, plan_cap, stored):
    monkeypatch.setattr(worker.db, "get_plan_cap", lambda uid: plan_cap)
    return worker._cap_for("u1", {"max_per_day": stored})


def test_a_user_can_apply_to_fewer_than_their_plan_allows(monkeypatch):
    assert _cap(monkeypatch, 5, 2) == 2


def test_a_user_cannot_raise_their_own_ceiling(monkeypatch):
    # Otherwise the daily limit box is a plan upgrade with no payment attached.
    assert _cap(monkeypatch, 5, 50) == 5


def test_an_unset_limit_falls_back_to_the_plan(monkeypatch):
    # 0 is the column's empty marker, not an instruction to apply to nothing —
    # reading it literally would silently stop the agent for every account that
    # predates the setting.
    assert _cap(monkeypatch, 5, 0) == 5
    assert _cap(monkeypatch, 5, None) == 5


def test_a_nonsense_value_falls_back_to_the_plan(monkeypatch):
    assert _cap(monkeypatch, 5, "many") == 5
    assert _cap(monkeypatch, 5, -3) == 5


def test_one_a_day_is_allowed(monkeypatch):
    # The smallest real answer, and the one that makes a watched first
    # application possible without touching prod config.
    assert _cap(monkeypatch, 15, 1) == 1
