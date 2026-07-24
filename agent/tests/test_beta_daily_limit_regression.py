import worker


def test_free_beta_receives_all_five_promised_daily_slots():
    for day in range(1, 29):
        assert worker._daily_apply_limit(
            "beta-user",
            plan_cap=5,
            today=f"2026-07-{day:02d}",
        ) == 5


def test_daily_limit_never_exceeds_the_plan():
    for plan_cap in (1, 3, 5, 15):
        assert worker._daily_apply_limit(
            "beta-user",
            plan_cap=plan_cap,
            today="2026-07-24",
        ) <= plan_cap
