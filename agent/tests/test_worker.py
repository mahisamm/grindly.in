import re

import worker
import safety


# ---------- _classify_failure ----------

def test_classify_failure_session_expired():
    assert worker._classify_failure("session expired, please login again") == \
        safety.FAILURE_REASON.SESSION_EXPIRED


def test_classify_failure_captcha():
    assert worker._classify_failure("blocked by a captcha check") == safety.FAILURE_REASON.CAPTCHA


def test_classify_failure_listing_closed():
    assert worker._classify_failure("this listing is no longer accepting applications") == \
        safety.FAILURE_REASON.LISTING_CLOSED


def test_classify_failure_upload_failed():
    assert worker._classify_failure("resume upload fail: rejected format") == \
        safety.FAILURE_REASON.UPLOAD_FAILED


def test_classify_failure_selector_missing():
    assert worker._classify_failure("submit button element not found") == \
        safety.FAILURE_REASON.SELECTOR_MISSING


def test_classify_failure_timeout():
    assert worker._classify_failure("navigation timed out after 30s") == \
        safety.FAILURE_REASON.TIMEOUT


def test_classify_failure_unrecognized_falls_back_to_exception():
    assert worker._classify_failure("something bizarre happened") == \
        safety.FAILURE_REASON.EXCEPTION


def test_classify_failure_handles_none():
    assert worker._classify_failure(None) == safety.FAILURE_REASON.EXCEPTION


# ---------- _jlist ----------

def test_jlist_parses_json_string():
    assert worker._jlist('["python", "react"]') == ["python", "react"]


def test_jlist_empty_or_none_returns_empty_list():
    assert worker._jlist(None) == []
    assert worker._jlist("") == []


def test_jlist_malformed_json_returns_empty_list_not_raise():
    assert worker._jlist("{not valid json") == []


def test_jlist_passthrough_for_actual_list():
    assert worker._jlist(["a", "b"]) == ["a", "b"]


# ---------- build_plan / _infer_domains ----------

def test_infer_domains_web_dev():
    assert worker._infer_domains(["react", "javascript"]) == ["web development"]


def test_infer_domains_multiple_matches_preserves_order():
    domains = worker._infer_domains(["python", "react"])
    assert domains == ["web development", "data science"]


def test_infer_domains_no_match_falls_back_to_software_development():
    assert worker._infer_domains(["cobol"]) == ["software development"]


def test_build_plan_prefers_explicit_domains_over_inferred():
    profile = {"preferred_domains": '["fintech"]', "stipend_min": 5000, "work_mode": "remote"}
    plan = worker.build_plan(profile, ["python"], cap=10)
    assert plan["domains"] == ["fintech"]
    assert plan["max_per_day"] == 10
    assert plan["stipend_min"] == 5000
    assert plan["work_mode"] == "remote"


def test_build_plan_infers_domains_when_profile_has_none():
    plan = worker.build_plan({}, ["react"], cap=5)
    assert plan["domains"] == ["web development"]
    assert plan["work_mode"] == "any"  # default
    assert plan["auto_apply"] is False  # default falsy


# ---------- _expand_search_keywords ----------

def test_expand_search_keywords_adds_matching_role_variants():
    variants = worker._expand_search_keywords(["web development"], ["react", "javascript"])
    assert ["web development"] in variants
    assert ["frontend developer"] in variants


def test_expand_search_keywords_deduplicates_and_caps_at_4():
    variants = worker._expand_search_keywords(
        ["web development", "data science"],
        ["react", "python", "sql", "kotlin", "java", "node"],
    )
    assert len(variants) <= 4
    assert len(variants) == len({str(v) for v in variants})  # no dupes


# ---------- _tailor_key ----------

def test_tailor_key_normalizes_and_truncates():
    key = worker._tailor_key("Frontend Developer Intern @ Acme!!")
    assert key == "frontend_developer_intern___ac"
    assert len(key) == 30
    assert re.fullmatch(r"[a-z0-9_]+", key)


# ---------- _scrape_jd_if_available ----------

class _ModWithScrapeJd:
    def scrape_jd(self, url, uid):
        return f"JD for {url}"


class _ModWithBrokenScrapeJd:
    def scrape_jd(self, url, uid):
        raise RuntimeError("selector changed")


class _ModWithoutScrapeJd:
    pass


def test_scrape_jd_if_available_calls_module_fn():
    result = worker._scrape_jd_if_available("internshala", _ModWithScrapeJd(), "https://x/1", "u1")
    assert result == "JD for https://x/1"


def test_scrape_jd_if_available_returns_empty_when_module_lacks_fn():
    assert worker._scrape_jd_if_available("internshala", _ModWithoutScrapeJd(), "https://x/1", "u1") == ""


def test_scrape_jd_if_available_swallows_exceptions():
    assert worker._scrape_jd_if_available("internshala", _ModWithBrokenScrapeJd(), "https://x/1", "u1") == ""


# ---------- _load_module / _fetch_live ----------

def test_load_module_returns_none_for_unknown_source():
    assert worker._load_module("not_a_real_platform_module") is None


class _ModWithBrokenFetch:
    def fetch(self, domains, limit, uid):
        raise RuntimeError("network down")


def test_fetch_live_returns_empty_list_on_exception():
    assert worker._fetch_live("x", _ModWithBrokenFetch(), ["web dev"], 5, "u1") == []


# ---------- cover_letter ----------

def test_cover_letter_falls_back_to_template_when_llm_returns_nothing(monkeypatch):
    monkeypatch.setattr(worker.llm_mod, "chat_ensemble", lambda *a, **kw: [])
    letter = worker.cover_letter("Alice", "Frontend Intern", "Acme", ["react", "python"], {})
    assert "Alice" in letter
    assert "Acme" in letter
    assert "Frontend Intern" in letter


def test_cover_letter_uses_llm_variant_mentioning_company(monkeypatch):
    monkeypatch.setattr(
        worker.llm_mod, "chat_ensemble",
        lambda *a, **kw: ["Hi Acme team, I would love to join as a Frontend Intern. Thanks, Alice"],
    )
    letter = worker.cover_letter("Alice", "Frontend Intern", "Acme", ["react"], {})
    assert "Acme" in letter


# ---------- _cooldown_active (captcha circuit breaker) ----------

def test_cooldown_active_false_when_no_row():
    assert worker._cooldown_active(None, cutoff=1000) is False


def test_cooldown_active_false_when_status_not_challenge():
    row = {"status": "connected", "updated_at": 5000}
    assert worker._cooldown_active(row, cutoff=1000) is False


def test_cooldown_active_true_within_window():
    # updated_at more recent than cutoff -> still cooling down
    row = {"status": "challenge_detected", "updated_at": 5000}
    assert worker._cooldown_active(row, cutoff=1000) is True


def test_cooldown_active_false_after_window_elapses():
    # updated_at older than cutoff -> cooldown has elapsed
    row = {"status": "challenge_detected", "updated_at": 500}
    assert worker._cooldown_active(row, cutoff=1000) is False


def test_cooldown_active_false_when_updated_at_missing():
    row = {"status": "challenge_detected", "updated_at": None}
    assert worker._cooldown_active(row, cutoff=1000) is False


# ---------- _requires_approval (one-tap apply gate) ----------

def test_requires_approval_true_for_adversarial_platform_even_with_auto_apply_on():
    for src in worker.ADVERSARIAL_PLATFORMS:
        assert worker._requires_approval(src, auto_apply=True) is True


def test_requires_approval_true_for_adversarial_platform_with_auto_apply_off():
    for src in worker.ADVERSARIAL_PLATFORMS:
        assert worker._requires_approval(src, auto_apply=False) is True


def test_requires_approval_false_for_non_adversarial_platform_with_auto_apply_on():
    assert worker._requires_approval("mock_ats", auto_apply=True) is False


def test_requires_approval_true_for_non_adversarial_platform_with_auto_apply_off():
    assert worker._requires_approval("mock_ats", auto_apply=False) is True


def test_adversarial_platforms_covers_all_five_current_integrations():
    # All 5 currently-integrated platforms ban bots in their ToS — none of
    # them are ATS-hosted company pages. If that ever changes, this test
    # should be the thing that forces a conscious update to the set.
    assert worker.ADVERSARIAL_PLATFORMS == frozenset(
        {"linkedin", "internshala", "naukri", "unstop", "indeed"}
    )


# ---------- _in_human_hours ----------

def test_in_human_hours_true_at_noon():
    assert worker._in_human_hours(12) is True


def test_in_human_hours_false_at_3am():
    assert worker._in_human_hours(3) is False


def test_in_human_hours_false_at_11pm():
    assert worker._in_human_hours(23) is False


def test_in_human_hours_boundaries_are_inclusive_start_exclusive_end():
    assert worker._in_human_hours(worker.HUMAN_HOURS_START) is True
    assert worker._in_human_hours(worker.HUMAN_HOURS_END) is False


# ---------- _daily_cap_for_today (human-pace volume) ----------

def test_daily_cap_for_today_scales_with_the_plan():
    # The human-pace band is half the plan cap up to the plan cap — it used to be
    # a flat randint(5, 10) for everyone, which meant the Pro upgrade (30/day)
    # bought exactly nothing. This test was still asserting the old flat band.
    for i in range(50):
        starter = worker._daily_cap_for_today(f"user{i}", plan_cap=10, today="2026-07-09")
        pro = worker._daily_cap_for_today(f"user{i}", plan_cap=30, today="2026-07-09")
        assert 5 <= starter <= 10
        assert 15 <= pro <= 30


def test_daily_cap_for_today_never_exceeds_plan_cap():
    cap = worker._daily_cap_for_today("u1", plan_cap=3, today="2026-07-09")
    assert cap == 3


def test_daily_cap_for_today_stable_within_same_day():
    a = worker._daily_cap_for_today("u1", plan_cap=30, today="2026-07-09")
    b = worker._daily_cap_for_today("u1", plan_cap=30, today="2026-07-09")
    assert a == b


def test_daily_cap_for_today_varies_across_dates():
    caps = {
        worker._daily_cap_for_today("u1", plan_cap=30, today=f"2026-07-{d:02d}")
        for d in range(1, 29)
    }
    assert len(caps) > 1  # not the same number every single day


def test_daily_cap_for_today_differs_per_user_on_same_day():
    caps = {
        worker._daily_cap_for_today(f"user{i}", plan_cap=30, today="2026-07-09")
        for i in range(20)
    }
    assert len(caps) > 1  # not every user gets the same number


# ---------- _platforms_for_today (platform rotation) ----------

def test_platforms_for_today_empty_when_none_available():
    assert worker._platforms_for_today("u1", [], today="2026-07-09") == []


def test_platforms_for_today_picks_1_or_2_platforms():
    for i in range(50):
        picked = worker._platforms_for_today(
            f"user{i}", worker.SOURCE_PRIORITY, today="2026-07-09"
        )
        assert 1 <= len(picked) <= 2

def test_platforms_for_today_never_exceeds_available():
    picked = worker._platforms_for_today("u1", ["linkedin"], today="2026-07-09")
    assert picked == ["linkedin"]


def test_platforms_for_today_picks_only_from_available():
    picked = worker._platforms_for_today(
        "u1", worker.SOURCE_PRIORITY, today="2026-07-09"
    )
    assert set(picked).issubset(set(worker.SOURCE_PRIORITY))


def test_platforms_for_today_stable_within_same_day():
    a = worker._platforms_for_today("u1", worker.SOURCE_PRIORITY, today="2026-07-09")
    b = worker._platforms_for_today("u1", worker.SOURCE_PRIORITY, today="2026-07-09")
    assert a == b


def test_platforms_for_today_rotates_across_dates():
    picks = [
        tuple(worker._platforms_for_today("u1", worker.SOURCE_PRIORITY, today=f"2026-07-{d:02d}"))
        for d in range(1, 29)
    ]
    assert len(set(picks)) > 1  # not the same platform(s) every single day


def test_platforms_for_today_biases_toward_two_when_multiple_connected():
    # The bias fix: with 2+ platforms connected, days should split volume
    # across two platforms more often than concentrating on one. Assert
    # 2-platform days actually occur (and, given the [1,2,2] weighting,
    # are the majority) so the concentration bug can't silently regress.
    two_days = sum(
        1
        for i in range(60)
        if len(worker._platforms_for_today(f"user{i}", worker.SOURCE_PRIORITY, today="2026-07-09")) == 2
    )
    assert two_days > 30  # majority land on 2 platforms
