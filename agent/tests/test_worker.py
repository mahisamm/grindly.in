import datetime
import re

import pytest

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


def test_classify_failure_browser_launch_is_not_listing_closed():
    # Playwright's launch error contains the word "closed"; it must not land
    # in LISTING_CLOSED, which drift.py excludes from the drift signal — a
    # 2026-07-31 dead-Xvfb incident failed every apply without one alert.
    assert worker._classify_failure(
        "could not start a browser: BrowserType.launch: Target page, context "
        "or browser has been closed"
    ) == safety.FAILURE_REASON.EXCEPTION


def test_classify_failure_browser_closed_mid_run():
    assert worker._classify_failure("Page.goto: Target page, context or browser has been closed") == \
        safety.FAILURE_REASON.EXCEPTION


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


def test_expand_search_keywords_deduplicates_and_stays_bounded():
    variants = worker._expand_search_keywords(
        ["web development", "data science"],
        ["react", "python", "sql", "kotlin", "java", "node"],
    )
    assert len(variants) <= worker.MAX_SEARCH_ANGLES
    assert len(variants) == len({str(v) for v in variants})  # no dupes


def test_every_stated_domain_is_searched():
    """The cap used to be four, applied to `domains[:2]` plus skill variants —
    so a third domain the user typed themselves was dropped without a word, and
    an AI-heavy resume was searched for as "web development" and nothing else."""
    variants = worker._expand_search_keywords(
        ["web development", "full stack", "ai intern"],
        ["python", "pytorch", "opencv", "yolov8", "react"],
    )
    asked = " ".join(v[0] for v in variants)
    assert "ai" in asked or "machine learning" in asked or "computer vision" in asked
    assert any("computer vision" in v[0] or "machine learning" in v[0] for v in variants)


# ---------- _tailor_key ----------

def test_tailor_key_is_filesystem_safe():
    key = worker._tailor_key("Frontend Developer Intern @ Acme!!", "Bolt & Co.")
    assert re.fullmatch(r"[a-z0-9_]+", key)   # it becomes a filename


def test_tailor_key_separates_the_same_title_at_different_companies():
    """The cache key used to be the title alone. "Web Development Internship" is on
    Internshala a hundred times over, asking for very different things each time —
    so one company's tailored resume was silently being sent to another's listing."""
    acme = worker._tailor_key("Web Development Internship", "Acme")
    bolt = worker._tailor_key("Web Development Internship", "Bolt")
    assert acme != bolt


def test_tailor_key_separates_titles_that_share_a_long_prefix():
    """The readable part of the key is the title cut to 30 characters. These two
    roles at one company are identical for 30 characters and want opposite
    resumes, so the truncated form handed the backend listing the frontend
    tailoring — and the run logged a tailored resume for a role that never got
    one."""
    back = worker._tailor_key("Software Development Engineer Intern - Backend", "Acme")
    front = worker._tailor_key("Software Development Engineer Intern - Frontend", "Acme")
    assert back != front


def test_tailor_key_separates_titles_that_differ_only_in_punctuation():
    """Non-alphanumerics collapse to "_", so the two below were one key. The
    languages are not the same language."""
    assert worker._tailor_key("C++ Developer", "Acme") != \
        worker._tailor_key("C Developer", "Acme")


def test_tailor_key_does_not_move_the_field_boundary():
    """A digest over "title + company" alone would let a longer title eat into
    the company's characters and match a shorter title at a longer company."""
    assert worker._tailor_key("Data Science", "Intern Corp") != \
        worker._tailor_key("Data Science Intern", "Corp")


def test_tailor_key_is_stable_for_the_same_role():
    """It is a cache key: the same listing seen twice in one run must hit, or
    every match re-runs the LaTeX tailoring."""
    assert worker._tailor_key("Backend Intern", "Acme") == \
        worker._tailor_key(" Backend Intern ", "ACME")


# ---------- _schedule_day ----------

def test_a_full_pipeline_spreads_evenly_over_the_month():
    """A sweep banks ~a month of matches at once (cap x days). They must come due a
    batch a day — dumping them at once would hand the user the whole list for free
    and tempt a same-day mass-apply, the loudest bot signal there is."""
    cap, days = 10, 30
    counts: dict[int, int] = {}
    for slot in range(cap * days):
        d = worker._schedule_day(slot, cap, days)
        counts[d] = counts.get(d, 0) + 1
    assert set(counts) == set(range(days))        # every day is used
    assert set(counts.values()) == {cap}          # ...and each gets exactly cap


def test_every_day_gets_a_share_of_the_best_matches():
    """`scored` is sorted best-first. A straight slot//cap fill would give day 1 the
    ten strongest matches and day 30 the dregs — each day visibly worse than the
    last, until the user concluded the agent had stopped working. Dealt round-robin,
    the top matches land on DIFFERENT days."""
    cap, days = 10, 30
    top_ten_days = {worker._schedule_day(s, cap, days) for s in range(10)}
    assert len(top_ten_days) == 1    # first daily batch is capped at ten links


def test_the_first_match_is_still_available_today():
    assert worker._schedule_day(0, 10, 30) == 0


def test_overflow_past_the_horizon_lands_on_the_last_day():
    cap, days = 10, 30
    assert worker._schedule_day(cap * days, cap, days) == days - 1
    assert worker._schedule_day(cap * days + 500, cap, days) == days - 1


def test_schedule_day_never_divides_by_zero():
    assert worker._schedule_day(5, 0, 0) == 0


def test_a_whole_batch_comes_due_together_at_its_day_boundary():
    """Today's batch (slots 0..cap-1) all comes due immediately, so a run yields
    matches the user can act on right away instead of one trickling in every few
    hours (which read as the agent having stopped). Exposure is bounded by the
    per-DAY cap, not by an intra-day trickle — the user submits each by hand."""
    now = datetime.datetime(2026, 7, 19, 0, 0)
    cap = 5
    batch0 = [worker._release_at(slot, cap, now) for slot in range(cap)]
    assert batch0 == [now] * cap                       # whole first batch, due now
    # first slot of the next batch lands exactly 24h later, together with its peers
    assert worker._release_at(cap, cap, now) == now + datetime.timedelta(days=1)
    assert worker._release_at(2 * cap, cap, now) == now + datetime.timedelta(days=2)


def test_delivery_sends_a_final_link_without_calling_a_platform(monkeypatch):
    app = {"id": "a1", "job_title": "Intern", "company": "Acme", "url": "https://x/1", "match_score": 81, "source": "linkedin"}
    monkeypatch.setattr(worker.db, "due_unnotified_matches", lambda uid, limit=50: [app])
    monkeypatch.setattr(worker.notify, "to_user", lambda user, subject, text: "https://x/1" in text)
    monkeypatch.setattr(worker.db, "mark_match_notified", lambda app_id: app_id == "a1")
    monkeypatch.setattr(worker.db, "add_audit", lambda *args, **kwargs: None)
    assert worker.deliver_ready_match("u1", {"id": "u1"}) == {"delivered": 1, "application_ids": ["a1"]}


def test_delivery_batches_several_due_matches_into_one_message(monkeypatch):
    """Previously this sent one notification per sweep tick (10 min apart) for
    each due match — a user with several due at once got a trickle of pings that
    read as the agent barely working. One call must now cover all of them."""
    apps = [
        {"id": "a1", "job_title": "Intern A", "company": "Acme", "url": "https://x/1", "match_score": 81, "source": "linkedin"},
        {"id": "a2", "job_title": "Intern B", "company": "Bolt", "url": "https://x/2", "match_score": 74, "source": "naukri"},
    ]
    monkeypatch.setattr(worker.db, "due_unnotified_matches", lambda uid, limit=50: apps)
    sent = {}
    def _capture(user, subject, text):
        sent["subject"], sent["text"] = subject, text
        return True
    monkeypatch.setattr(worker.notify, "to_user", _capture)
    monkeypatch.setattr(worker.db, "mark_match_notified", lambda app_id: True)
    monkeypatch.setattr(worker.db, "add_audit", lambda *args, **kwargs: None)
    out = worker.deliver_ready_match("u1", {"id": "u1"})
    assert out == {"delivered": 2, "application_ids": ["a1", "a2"]}
    assert "2 application links" in sent["subject"]
    assert "https://x/1" in sent["text"] and "https://x/2" in sent["text"]


# ---------- _prepare_answers_if_available (Apply Kit: drafted screening answers) ----------

class _ModNoQuestions:
    """A platform adapter that hasn't been wired for read-only question harvest
    yet — the common case until each platform is done one at a time."""


class _ModEmptyQuestions:
    def harvest_questions(self, url, uid):
        return []


class _ModWithQuestions:
    def harvest_questions(self, url, uid):
        return [{"kind": "tel", "label": "Phone number", "required": True, "options": []}]


class _ModRaises:
    def harvest_questions(self, url, uid):
        raise RuntimeError("form changed, selector missing")


def test_prepare_answers_returns_none_when_platform_not_wired_for_it():
    out = worker._prepare_answers_if_available(
        "linkedin", _ModNoQuestions(), "https://x/1", "u1", {}, [], {"title": "T", "company": "C"},
    )
    assert out is None


def test_prepare_answers_returns_none_on_empty_fields():
    out = worker._prepare_answers_if_available(
        "linkedin", _ModEmptyQuestions(), "https://x/1", "u1", {}, [], {"title": "T", "company": "C"},
    )
    assert out is None


def test_prepare_answers_returns_none_with_no_url():
    out = worker._prepare_answers_if_available(
        "linkedin", _ModWithQuestions(), "", "u1", {}, [], {"title": "T", "company": "C"},
    )
    assert out is None


def test_prepare_answers_drafts_a_profile_fact_without_calling_an_llm(monkeypatch):
    """A phone-number field is answerable straight from the profile — the LLM must
    never be consulted for something checkable, let alone for a field that isn't
    even open-ended (see questions._deterministic)."""
    def _should_not_be_called(*a, **k):
        raise AssertionError("must not call the LLM for a profile-answerable field")
    monkeypatch.setattr(worker.llm_mod, "chat_json_ensemble", _should_not_be_called)

    out = worker._prepare_answers_if_available(
        "internshala", _ModWithQuestions(), "https://x/1", "u1",
        {"phone": "9999999999"}, ["python"], {"title": "SDE Intern", "company": "Acme"},
    )
    assert out is not None
    assert "9999999999" in out
    assert "Phone number" in out


def test_prepare_answers_swallows_a_harvest_exception():
    """A platform's read-only harvest step breaking (site redesign, timeout) must
    degrade to 'no drafted answers for this one', never blow up the run that's
    also trying to bank the match itself."""
    out = worker._prepare_answers_if_available(
        "linkedin", _ModRaises(), "https://x/1", "u1", {}, [], {"title": "T", "company": "C"},
    )
    assert out is None


def test_delivery_with_nothing_due_sends_nothing(monkeypatch):
    monkeypatch.setattr(worker.db, "due_unnotified_matches", lambda uid, limit=50: [])
    assert worker.deliver_ready_match("u1", {"id": "u1"}) == {"delivered": 0}


# ---------- pipeline refill hysteresis ----------

def _stocked(depth: int, cap: int = 10) -> bool:
    """Mirrors the discovery gate in run_for_user: do we still hold enough work to
    skip scraping the boards this run?"""
    return depth >= cap * worker.PIPELINE_REFILL_DAYS


def test_a_nearly_full_pipeline_does_not_trigger_a_rescrape():
    """The bug this guards: "refill unless full" means approving ONE application
    drops the depth below full, so the next sweep re-scrapes all five boards. The
    pipeline would refill every single day — exactly the traffic pattern the whole
    design exists to avoid."""
    cap, full = 10, 10 * worker.PIPELINE_DAYS
    assert _stocked(full, cap)
    assert _stocked(full - 1, cap)     # one application sent: still stocked
    assert _stocked(full // 2, cap)    # half the month gone: still stocked


def test_a_drained_pipeline_does_trigger_a_rescrape():
    cap = 10
    assert not _stocked(cap * worker.PIPELINE_REFILL_DAYS - 1, cap)
    assert not _stocked(0, cap)


def test_the_refill_threshold_sits_below_the_fill_target():
    """Refilling at the same depth we fill to is the no-hysteresis bug by another
    name — the two constants must not converge."""
    assert worker.PIPELINE_REFILL_DAYS < worker.PIPELINE_DAYS


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

@pytest.fixture
def fail_closed_default(monkeypatch):
    """Pin the fleet auto-apply switches to their unconfigured (fail-closed)
    state. `_requires_approval` delegates to safety.requires_manual_final_submit,
    which reads GRINDLY_AUTO_APPLY_MODE / GRINDLY_TIER_B_APPLY from the
    environment — and db.py loads the project-root .env at import, so a developer
    whose local .env sets mode=live + tier_b=1 (a legitimate way to exercise the
    beta contract) would otherwise see internshala, a Tier B board, resolve to
    'no approval needed' here and flip these assertions. Fail-closed is the
    default this test means to assert, so make it explicit instead of ambient."""
    monkeypatch.delenv("GRINDLY_AUTO_APPLY_MODE", raising=False)
    monkeypatch.delenv("GRINDLY_TIER_B_APPLY", raising=False)


def test_requires_approval_true_for_adversarial_platform_even_with_auto_apply_on(fail_closed_default):
    for src in worker.ADVERSARIAL_PLATFORMS:
        assert worker._requires_approval(src, auto_apply=True) is True


def test_requires_approval_true_for_adversarial_platform_with_auto_apply_off(fail_closed_default):
    for src in worker.ADVERSARIAL_PLATFORMS:
        assert worker._requires_approval(src, auto_apply=False) is True


def test_tier_c_boards_still_require_approval_even_in_live_tier_b_mode(monkeypatch):
    """The safety floor that must hold in the most permissive real config. With
    the fleet live AND Tier B switched on — the exact beta hosted-apply setting —
    Internshala (Tier B, consented) may submit unattended, but LinkedIn, Naukri,
    Unstop and Indeed (Tier C) must STILL fail closed. A regression that let a
    Tier C board through here is an account-ban risk for the user."""
    monkeypatch.setenv("GRINDLY_AUTO_APPLY_MODE", "live")
    monkeypatch.setenv("GRINDLY_TIER_B_APPLY", "1")
    for src in ("linkedin", "naukri", "unstop", "indeed"):
        assert worker._requires_approval(src, auto_apply=True) is True, src
    # The one board the beta contract does allow, so the test can't pass by the
    # gate simply being stuck on for everything.
    assert worker._requires_approval("internshala", auto_apply=True) is False


def test_requires_approval_true_for_an_unknown_future_platform_with_auto_apply_on():
    # New sources must not accidentally inherit unattended submit permission.
    assert worker._requires_approval("mock_ats", auto_apply=True) is True


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


# ---------- manual runs bypass the human-hours defer ----------

def _stub_pre_gate(monkeypatch, hour: int):
    """Stub everything run_for_user touches before the human-hours gate, then
    make get_connected_platforms return [] so it exits right AFTER the gate with
    a distinct 'no_platforms_connected' error. That lets a test tell 'got past
    the gate' (no_platforms) apart from 'blocked at the gate' (deferred)."""
    monkeypatch.setattr(worker.db, "get_user",
                        lambda uid: {"profile": {"skills": '["python"]'}, "name": "T", "email": "t@x"})
    monkeypatch.setattr(worker.db, "get_user_plan", lambda uid: "free")
    monkeypatch.setattr(worker.db, "get_plan_cap", lambda uid: 5)
    monkeypatch.setattr(worker, "_daily_cap_for_today", lambda uid, cap, today=None: cap)
    monkeypatch.setattr(worker.db, "todays_applied_count", lambda uid: 0)
    monkeypatch.setattr(worker.db, "add_audit", lambda *a, **k: None)
    monkeypatch.setattr(worker.resume_parse, "find_resume_file", lambda uid: None)
    monkeypatch.setattr(worker.db, "set_resume_parse_failed", lambda uid, v: None)
    monkeypatch.setattr(worker.db, "get_outcome_stats",
                        lambda uid: {"total": 0, "rejection_rate": 0.0, "response_rate": 0.0})
    monkeypatch.setattr(worker.db, "update_skills", lambda *a, **k: None)
    monkeypatch.setattr(worker, "_ist_hour", lambda: hour)
    monkeypatch.setattr(worker.notify, "to_user", lambda *a, **k: True)
    monkeypatch.setattr(worker.db, "get_connected_platforms", lambda uid: [])


def test_manual_run_bypasses_human_hours_gate_at_night(monkeypatch):
    _stub_pre_gate(monkeypatch, hour=1)  # 1am IST — outside 9-21
    # Discovery no longer needs a connected platform, so a manual run proceeds
    # PAST the gate into real work. Halt it at the first post-gate call
    # (get_connected_platforms) to prove the gate was bypassed without standing up
    # a full DB: a deferred run returns BEFORE ever reaching that call.
    reached = {"past_gate": False}

    def _mark(uid):
        reached["past_gate"] = True
        raise RuntimeError("halt after gate")

    monkeypatch.setattr(worker.db, "get_connected_platforms", _mark)
    try:
        out = worker.run_for_user("u1", "live", manual=True)
    except RuntimeError:
        out = {}
    assert reached["past_gate"] is True   # manual run bypassed the 9-21 gate
    assert "deferred" not in out


def test_scheduled_run_still_deferred_at_night(monkeypatch):
    _stub_pre_gate(monkeypatch, hour=1)
    out = worker.run_for_user("u1", "live", manual=False)
    assert out.get("deferred") == "outside_human_hours"


def test_run_job_treats_queue_runs_as_manual(monkeypatch):
    seen = {}
    monkeypatch.setattr(
        worker, "run_for_user",
        lambda uid, mode, manual=False: seen.update(uid=uid, mode=mode, manual=manual) or {},
    )
    worker.run_job("u1", "live")
    assert seen == {"uid": "u1", "mode": "live", "manual": True}


# ---------- _daily_cap_for_today (human-pace volume) ----------

def test_daily_cap_for_today_scales_with_the_plan():
    # The human-pace band is half the plan cap up to the plan cap — it used to be
    # a flat randint(5, 10) for everyone, which meant the Pro upgrade
    # bought exactly nothing. This test was still asserting the old flat band.
    for i in range(50):
        starter = worker._daily_cap_for_today(f"user{i}", plan_cap=5, today="2026-07-09")
        pro = worker._daily_cap_for_today(f"user{i}", plan_cap=15, today="2026-07-09")
        assert 3 <= starter <= 5
        assert 7 <= pro <= 15


def test_daily_cap_for_today_never_exceeds_plan_cap():
    cap = worker._daily_cap_for_today("u1", plan_cap=3, today="2026-07-09")
    assert cap == 3


def test_daily_cap_for_today_stable_within_same_day():
    a = worker._daily_cap_for_today("u1", plan_cap=15, today="2026-07-09")
    b = worker._daily_cap_for_today("u1", plan_cap=15, today="2026-07-09")
    assert a == b


def test_daily_cap_for_today_varies_across_dates():
    caps = {
        worker._daily_cap_for_today("u1", plan_cap=15, today=f"2026-07-{d:02d}")
        for d in range(1, 29)
    }
    assert len(caps) > 1  # not the same number every single day


def test_daily_cap_for_today_differs_per_user_on_same_day():
    caps = {
        worker._daily_cap_for_today(f"user{i}", plan_cap=15, today="2026-07-09")
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


def test_platforms_for_today_always_includes_primary():
    # The top-priority connected platform must run EVERY day, so a day's dice can
    # never strand the user on only a weaker/broken board (the "unstop-only day"
    # that surfaced 0 matches while internshala — which works — sat untouched).
    # available is SOURCE_PRIORITY-ordered, so index 0 is the primary.
    available = [s for s in worker.SOURCE_PRIORITY if s in ("internshala", "unstop")]
    assert available[0] == "internshala"
    for d in range(1, 32):
        picked = worker._platforms_for_today("u1", available, today=f"2026-08-{d:02d}")
        assert "internshala" in picked, f"primary missing on 2026-08-{d:02d}: {picked}"


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


# ---------- analyze_only must not fail silently ----------
#
# The real failure: a resume file that exists but yields no text (a scanned or
# image-only PDF). analyze_only returned an error and left resume_parse_failed
# False, so the dashboard showed a happily-uploaded resume that silently powered
# no matching, no skills and no score — with nothing anywhere saying why.

def test_analyze_only_flags_a_resume_it_cannot_read(monkeypatch):
    flagged = {}
    monkeypatch.setattr(worker.db, "get_user", lambda uid: {"profile": {}})
    monkeypatch.setattr(worker.resume_parse, "find_resume_file", lambda uid: "/tmp/cv.pdf")
    monkeypatch.setattr(worker.resume_parse, "extract_text", lambda p: "")
    monkeypatch.setattr(worker.db, "set_resume_parse_failed",
                        lambda uid, v: flagged.update({uid: v}))
    assert worker.analyze_only("u1") == {"error": "resume_unreadable"}
    assert flagged == {"u1": True}


def test_analyze_only_does_not_flag_a_user_with_no_resume_at_all(monkeypatch):
    """Never uploaded is not a parse failure. Flagging it would put a "we
    couldn't read your resume" warning on someone who never gave us one."""
    calls = []
    monkeypatch.setattr(worker.db, "get_user", lambda uid: {"profile": {}})
    monkeypatch.setattr(worker.resume_parse, "find_resume_file", lambda uid: None)
    monkeypatch.setattr(worker.db, "set_resume_parse_failed",
                        lambda uid, v: calls.append((uid, v)))
    assert worker.analyze_only("u1") == {"error": "no resume"}
    assert calls == []
