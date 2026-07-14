"""Grindly agent worker.

One run for one user:
  1. Parse resume -> extract skills (local LLM, heuristic fallback).
  1.5 Analyze resume quality -> save score + suggestions to DB.
  2. Build a plan from the proff answers.
  3. Fetch listings from all connected platforms (in priority order).
  4. Score each vs skills, apply the firewall, tailor resume, and submit
     to strong matches up to the daily cap.
  5. Write applications + a daily report into the shared DB.
  6. Send a Slack progress report via the notify adapter.

Platform priority (highest first): linkedin > internshala > naukri > unstop > indeed

Daily cap:  starter = 10/day   pro = 30/day

Usage:
  python worker.py --user <uid> --mode live --once
  python worker.py --user <uid> --analyze          # resume analyze only, no jobs
  python worker.py --loop                           # service mode: sweep all active users
"""
from __future__ import annotations
import argparse
import concurrent.futures
import importlib
import json
import logging
import os
import random
import re
import sys
import time
import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, os.path.dirname(__file__))

import db
import notify
import matcher
import resume_parse
import resume_ai
import safety
import llm as llm_mod

logging.basicConfig(
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    level=logging.INFO,
)
log = logging.getLogger("grindly.worker")

# Optional Sentry error tracking — set SENTRY_DSN env var to enable
_SENTRY_DSN = os.environ.get("SENTRY_DSN", "")
if _SENTRY_DSN:
    try:
        import sentry_sdk
        sentry_sdk.init(dsn=_SENTRY_DSN, traces_sample_rate=0.05)
        log.info("Sentry initialized")
    except ImportError:
        log.warning("SENTRY_DSN set but sentry-sdk not installed — pip install sentry-sdk")

# Ops alert channel for things the team needs to see (not the end user) — high
# platform failure rates, worker crashes. Defaults to a stub channel name;
# with SLACK_BOT_TOKEN unset this just appends to data/slack-outbox.jsonl like
# everything else notify.send() writes.
_OPS_CHANNEL = os.environ.get("OPS_SLACK_CHANNEL", "ops-alerts")


def _classify_failure(why: str) -> str:
    """Map a freeform apply failure message to an enumerated FAILURE_REASON."""
    w = (why or "").lower()
    if "login" in w or "session" in w or "logged out" in w:
        return safety.FAILURE_REASON.SESSION_EXPIRED
    if "captcha" in w or "human" in w:
        return safety.FAILURE_REASON.CAPTCHA
    if "closed" in w or "expired" in w or "no longer" in w:
        return safety.FAILURE_REASON.LISTING_CLOSED
    if "upload" in w or "resume" in w and "fail" in w:
        return safety.FAILURE_REASON.UPLOAD_FAILED
    if "selector" in w or "not found" in w or "element" in w:
        return safety.FAILURE_REASON.SELECTOR_MISSING
    if "timeout" in w or "timed out" in w:
        return safety.FAILURE_REASON.TIMEOUT
    return safety.FAILURE_REASON.EXCEPTION


# IST by default — a human job-searching isn't online at 3am. Env-overridable
# so a non-India launch can shift the window without a code change (the deeper
# fix, per-user timezone, needs profile tz data we don't collect yet).
HUMAN_HOURS_START = int(os.environ.get("GRINDLY_HUMAN_HOURS_START", "9"))
HUMAN_HOURS_END = int(os.environ.get("GRINDLY_HUMAN_HOURS_END", "21"))


def _in_human_hours(hour: int) -> bool:
    return HUMAN_HOURS_START <= hour < HUMAN_HOURS_END


def _daily_cap_for_today(uid: str, plan_cap: int, today: str | None = None) -> int:
    """Human-pace ceiling: a person applying manually sends roughly 5-10
    applications a day, not the plan's raw 10-30/day allowance. Seeded by
    uid+date so repeat runs the same day don't reroll, but the number varies
    day to day and user to user — an identical count every single day is
    itself a bot signal. Never exceeds the plan's own cap."""
    today = today or datetime.date.today().isoformat()
    rng = random.Random(f"{uid}:{today}:cap")
    # Scale the human-pace band with the plan so Pro (30/day) genuinely
    # applies to more than Starter (10/day). Previously this was a flat
    # randint(5,10) for everyone, so the Pro upgrade bought nothing.
    cap = max(1, int(plan_cap))
    low = max(3, cap // 2)
    if low >= cap:
        return cap
    return min(cap, rng.randint(low, cap))


def _platforms_for_today(uid: str, available: list[str], today: str | None = None) -> list[str]:
    """Rotate which connected platforms actually get touched today. Hitting
    all 5 platforms every single day is itself a bot signal — a human
    job-searching doesn't check every site daily. Seeded by uid+date so
    re-runs the same day pick the same platforms, but the set rotates daily
    and differs per user (so many users don't all hit the same platform on
    the same day).

    Biased toward 2 platforms (not 1) when 2+ are connected: the daily cap
    is 5-10 applies, and dumping all of that onto a single site in one day
    looks more bot-like per-platform than splitting it across two."""
    if not available:
        return []
    today = today or datetime.date.today().isoformat()
    rng = random.Random(f"{uid}:{today}:platforms")
    n = min(len(available), rng.choice([1, 2, 2]))
    ordered = sorted(available)
    rng.shuffle(ordered)
    return ordered[:n]


def _requires_approval(src: str, auto_apply: bool) -> bool:
    """True if a match must land in the matched->approve queue instead of an
    immediate live submit. ADVERSARIAL_PLATFORMS forces this regardless of the
    user's auto_apply setting — a bot submitting on a platform whose ToS bans
    bots is what gets accounts banned; that risk isn't something a settings
    toggle should be able to waive."""
    return src in ADVERSARIAL_PLATFORMS or not auto_apply


def _cooldown_active(row: dict | None, cutoff) -> bool:
    """True if an integration row is still inside its post-challenge cooldown.
    Pure function (no DB access) so it's testable with plain dicts: caller
    passes `db.get_integration(uid, src)` and `db.time_ago_db(CHALLENGE_COOLDOWN_MS)`."""
    if not row or row.get("status") != "challenge_detected":
        return False
    updated_at = row.get("updated_at")
    if updated_at is None:
        return False
    return updated_at >= cutoff

# Source priority order — agent applies across platforms in this sequence.
SOURCE_PRIORITY = ["linkedin", "internshala", "naukri", "unstop", "indeed"]

# Platforms whose ToS prohibits automated submission (all 5 we currently
# integrate — none of them are ATS-hosted company pages that welcome bots).
# For these, the bot is never allowed to click the final submit button on its
# own: it fills nothing eagerly, scores the job, and files it as "matched" so
# a human has to tap Approve in the dashboard before anything gets sent. That
# single human tap is what keeps the account off the hook for automation —
# a bot acting on standing permission is exactly what gets accounts banned;
# a bot acting on a specific human decision per job is not. If a
# non-adversarial ATS integration (Greenhouse/Lever/Workday) is ever added,
# it belongs outside this set and can stay fully automatic.
ADVERSARIAL_PLATFORMS = frozenset(SOURCE_PRIORITY)

# --- Beta safety rails -------------------------------------------------------
# Two independent hard caps that sit *under* the user's plan cap. They exist so a
# bug or an over-eager run can never mass-apply (which gets accounts flagged as
# bots). Both are env-overridable so we can loosen them after beta without a
# code change. 0 disables a cap.
#   GRINDLY_CAP_PER_PLATFORM — max applies to one platform in a single run (5)
#   GRINDLY_CAP_PER_RUN      — max applies total in a single run (0 = use plan cap)
SAFETY_CAP_PER_PLATFORM = int(os.environ.get("GRINDLY_CAP_PER_PLATFORM", "15"))
SAFETY_CAP_PER_RUN = int(os.environ.get("GRINDLY_CAP_PER_RUN", "0"))
# How many of the top-scoring listings get their full job description fetched and
# re-scored BEFORE the threshold decides (see step 4b). Each one is a page load,
# so this is deliberately bounded rather than "all of them".
JD_RESCORE_LIMIT = int(os.environ.get("GRINDLY_JD_RESCORE_LIMIT", "12"))
# Spread applies over time to mimic human pacing — set GRINDLY_SPREAD_APPLIES=1 in prod.
# Each successful apply pauses 5-15 min before the next one.
_SPREAD_APPLIES = os.environ.get("GRINDLY_SPREAD_APPLIES", "0") == "1"
_SPREAD_GAP_SEC = (300, 900)
# Baseline pacing floor — applies after every attempt (success, fail, or
# ambiguous), unconditionally. _SPREAD_GAP_SEC above is an extra long pause
# layered on top of this for successes only; this floor exists so a run
# doesn't fire attempts back-to-back at machine speed on any outcome, which is
# itself a bot tell independent of spread mode.
_BASE_PACE_SEC = (3, 8)

# CAPTCHA/challenge circuit breaker — a challenge means the site already
# flagged us as a bot; hitting it again immediately is how accounts get
# banned. Once seen, stop attempting that platform for the rest of this run
# AND skip it on future runs until the cooldown elapses.
CHALLENGE_COOLDOWN_MS = 6 * 60 * 60 * 1000  # 6h

# Directory for per-job tailored resume PDFs
_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.join(_AGENT_DIR, "..")


def _jlist(v):
    if not v:
        return []
    try:
        return json.loads(v) if isinstance(v, str) else list(v)
    except Exception:  # noqa: BLE001
        return []


def build_plan(profile: dict, skills: list[str], cap: int) -> dict:
    return {
        "skills": skills,
        "domains": _jlist(profile.get("preferred_domains")) or _infer_domains(skills),
        "locations": _jlist(profile.get("preferred_locations")),
        "work_mode": profile.get("work_mode") or "any",
        "stipend_min": profile.get("stipend_min") or 0,
        "min_match_score": profile.get("min_match_score") or 65,
        "max_per_day": cap,
        "auto_apply": bool(profile.get("auto_apply")),
        "excluded": _jlist(profile.get("excluded_companies")),
        "exp_level": profile.get("experience_level"),
    }


def _infer_domains(skills: list[str]) -> list[str]:
    s = set(skills)
    domains = []
    if s & {"react", "javascript", "html", "css", "typescript"}:
        domains.append("web development")
    if s & {"python", "pandas", "machine learning", "pytorch", "numpy"}:
        domains.append("data science")
    if s & {"kotlin", "android", "flutter", "swift"}:
        domains.append("mobile development")
    if s & {"figma", "ui/ux"}:
        domains.append("ui ux design")
    return domains or ["software development"]


def cover_letter(name: str, title: str, company: str, skills: list[str], job: dict, jd_text: str = "") -> str:
    """Per-job cover letter: try local LLM first, fall back to template."""
    job_skills_str = ", ".join((job.get("skills") or [])[:5])
    jd_excerpt = f" Role context: {jd_text[:300]}" if jd_text else ""
    prompt = (
        f"Write a short, natural internship cover letter (3 sentences max) "
        f"from {name or 'a candidate'} applying for {title} at {company}. "
        f"Candidate skills: {', '.join(skills[:5])}. "
        f"Role requires: {job_skills_str or title}.{jd_excerpt} "
        f"No 'Dear Sir/Madam', no placeholders. "
        f"End with: Thanks, {name or 'Applicant'}"
    )
    variants = llm_mod.chat_ensemble(prompt, n=2, timeout=35)
    if variants:
        co_low = company.lower()
        best = max(variants, key=lambda v: v.lower().count(co_low) * 10 + len(v))
        if len(best.strip()) > 50:
            return best.strip()

    top = ", ".join(skills[:4]) if skills else "the required skills"
    return (
        f"Hi {company} team,\n\n"
        f"I'm excited to apply for the {title} internship. My background in {top} "
        f"lines up closely with what this role needs, and I pick up new tools fast. "
        f"I'd love to contribute and learn with your team.\n\n"
        f"Thanks,\n{name or 'Applicant'}"
    )


def _expand_search_keywords(domains: list[str], skills: list[str]) -> list[list[str]]:
    """Return 2-4 keyword variant sets for broader job discovery."""
    skill_low = {s.lower() for s in skills}
    variants: list[list[str]] = [[d] for d in domains[:2]]

    if skill_low & {"react", "javascript", "typescript", "vue", "angular"}:
        variants.append(["frontend developer"])
    if skill_low & {"python", "django", "flask", "fastapi"}:
        variants.append(["python developer"])
    if skill_low & {"machine learning", "pytorch", "tensorflow", "pandas", "sklearn"}:
        variants.append(["machine learning engineer"])
    if skill_low & {"kotlin", "android", "flutter", "dart", "swift"}:
        variants.append(["mobile developer"])
    if skill_low & {"java", "spring", "springboot"}:
        variants.append(["java developer"])
    if skill_low & {"node", "express", "mongodb", "nestjs"}:
        variants.append(["backend developer"])
    if skill_low & {"sql", "postgresql", "mysql", "data analysis", "excel", "tableau"}:
        variants.append(["data analyst"])

    seen: set[str] = set()
    result: list[list[str]] = []
    for v in variants:
        key = str(v)
        if key not in seen:
            seen.add(key)
            result.append(v)
    return result[:4]  # cap at 4 to avoid hammering platforms


def _scrape_jd_if_available(src: str, mod, url: str, uid: str) -> str:
    """Call mod.scrape_jd() if it exists; return '' otherwise."""
    fn = getattr(mod, "scrape_jd", None)
    if fn is None:
        return ""
    try:
        return fn(url, uid) or ""
    except Exception as e:  # noqa: BLE001
        log.warning("%s scrape_jd error: %s", src, e)
        return ""


def _ist_hour() -> int:
    """Current hour in IST (UTC+5:30) — no external dependency."""
    utc = datetime.datetime.now(datetime.timezone.utc)
    ist = utc + datetime.timedelta(hours=5, minutes=30)
    return ist.hour


def _load_module(source: str):
    """Import platform module; returns None if import fails."""
    try:
        return importlib.import_module(source)
    except ImportError as e:
        log.error("cannot import %s: %s", source, e)
        return None


def _fetch_live(source: str, mod, domains: list[str], limit: int, uid: str) -> list[dict]:
    try:
        return mod.fetch(domains, limit=limit, uid=uid)
    except Exception as e:  # noqa: BLE001
        log.error("%s fetch error: %s", source, e)
        return []


def _fetch_source_all_kw(
    src: str, mod, kw_sets: list[list[str]], per_kw: int, uid: str
) -> tuple[str, list[dict]]:
    """Fetch one platform across all keyword sets; dedup by external_id. Thread-safe — each platform has isolated browser context.

    Firing every search back-to-back the instant login completes is itself a
    bot tell independent of apply pacing — a human tries one search term,
    looks at results, then tries the next. A small gap between searches
    matches that rhythm without materially slowing the run."""
    seen_eids: set[str] = set()
    jobs: list[dict] = []
    for i, kw_list in enumerate(kw_sets):
        if i > 0:
            time.sleep(random.uniform(*_BASE_PACE_SEC))
        for j in _fetch_live(src, mod, kw_list, per_kw + 5, uid):
            eid = j.get("external_id") or j.get("url", "")
            if eid and eid not in seen_eids:
                jobs.append(j)
                seen_eids.add(eid)
    log.info("%s: fetched %d unique listings (%d keyword sets)", src, len(jobs), len(kw_sets))
    return src, jobs


def _tailor_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]", "_", title.lower()[:30])


def analyze_only(uid: str) -> dict:
    """Parse + analyze resume for a user, save to DB, return analysis."""
    user = db.get_user(uid)
    if not user:
        log.warning("no user %s", uid)
        return {"error": "no user"}

    profile = user.get("profile") or {}
    text = profile.get("resume_text") or ""
    if not text:
        path = resume_parse.find_resume_file(uid)
        if path:
            text = resume_parse.extract_text(path)
            if text:
                db.set_resume_text(uid, text)

    if not text:
        log.warning("no resume text for %s", uid)
        return {"error": "no resume"}

    skills = _jlist(profile.get("skills"))
    if not skills:
        skills = resume_parse.extract_skills(text)
        if skills:
            db.update_skills(uid, skills)

    analysis = resume_ai.analyze(text)
    db.set_resume_analysis(uid, analysis["score"], json.dumps(analysis))
    log.info(
        "resume analysis: score=%d/100 grade=%s issues=%d",
        analysis["score"], analysis["grade"], len(analysis["issues"]),
    )
    return analysis


def run_for_user(uid: str, mode: str = "live") -> dict:
    user = db.get_user(uid)
    if not user:
        log.warning("no user %s", uid)
        return {"error": "no user"}

    profile = user.get("profile") or {}
    name = user.get("name") or (user.get("email") or "").split("@")[0]

    # "approved" = submit-only. Fired when the user taps Approve in the dashboard:
    # send the applications they just OK'd and nothing else. Skips discovery
    # entirely (no scraping, no scoring), because tapping Approve on one job
    # shouldn't cost a full multi-minute sweep of every board. All the safety
    # machinery — human hours, daily cap, pacing, the challenge breaker — still
    # applies; it is the same submit path a normal run uses in step 4a.
    submit_only = mode == "approved"
    live = mode in ("live", "approved")

    cap = _daily_cap_for_today(uid, db.get_plan_cap(uid))
    log.info("=== run for %s (%s) mode=%s cap=%d/day (human-pace) ===", name, uid, mode, cap)
    db.add_audit("run_start", user_id=uid, detail=f"mode={mode} cap={cap}")
    # consent trace: auto-apply submits on the user's behalf — record whether
    # they explicitly consented (profile.auto_apply_consent_at). Prototype only
    # warns; production should refuse auto-apply without a consent timestamp.
    if profile.get("auto_apply") and not profile.get("auto_apply_consent_at"):
        log.warning("BLOCKED: auto_apply on without consent timestamp — refusing to submit applications")
        db.add_audit("consent_blocked", user_id=uid, detail="auto_apply blocked: no consent timestamp")
        notify.to_user(
            user,
            "Grindly: action needed — confirm your settings",
            ":lock: *Agent blocked* — auto-apply requires explicit consent. "
            "Re-open the dashboard, confirm your settings, and re-activate to continue.",
        )
        return {"error": "consent_required", "message": "auto_apply blocked: no consent timestamp on record"}

    # 1. resume -> skills
    skills = _jlist(profile.get("skills"))
    text = profile.get("resume_text") or ""
    if not text:
        path = resume_parse.find_resume_file(uid)
        if path:
            text = resume_parse.extract_text(path)
            if text:
                db.set_resume_text(uid, text)
    if (not skills) and text:
        skills = resume_parse.extract_skills(text)
        log.info("extracted %d skills: %s", len(skills), skills)

    # Surface parse failure instead of silently scoring everything as neutral —
    # the dashboard turns this flag into a "add your skills manually" prompt.
    parse_failed = not skills
    db.set_resume_parse_failed(uid, parse_failed)
    if parse_failed:
        log.warning("no skills available — matches will be weak until skills are set")
        notify.to_user(
            user,
            "Grindly: I couldn't read your resume skills",
            ":warning: I couldn't read any skills from your resume. Open the dashboard "
            "(Resume Intelligence → Edit skills) and add them so I can match you accurately.",
        )

    # 1.5 Resume analysis — always run so dashboard reflects current quality
    if text:
        analysis = resume_ai.analyze(text)
        db.set_resume_analysis(uid, analysis["score"], json.dumps(analysis))
        log.info(
            "resume score: %d/100 (%s) — %d issue(s)",
            analysis["score"], analysis["grade"], len(analysis["issues"]),
        )

    # 2. plan
    plan = build_plan(profile, skills, cap)
    _stats = db.get_outcome_stats(uid)
    if _stats["total"] >= 10 and _stats["rejection_rate"] > 0.70:
        plan["min_match_score"] = min(80, plan["min_match_score"] + 8)
        log.info("adaptive: rejection_rate=%.0f%% → threshold tightened to %d", _stats["rejection_rate"] * 100, plan["min_match_score"])
    elif _stats["total"] >= 20 and _stats["response_rate"] < 0.05:
        plan["min_match_score"] = max(40, plan["min_match_score"] - 5)
        log.info("adaptive: response_rate=%.0f%% → threshold relaxed to %d", _stats["response_rate"] * 100, plan["min_match_score"])
    db.update_skills(uid, skills, plan)
    ist_h = _ist_hour()
    log.info(
        "plan: domains=%s threshold=%d cap=%d IST=%dh",
        plan["domains"], plan["min_match_score"], plan["max_per_day"], ist_h,
    )

    # Human-hours gate — a real job-seeker isn't browsing LinkedIn at 3am.
    # Running live outside a plausible daytime window is itself a bot tell,
    # independent of pacing within the run. Mock mode is unaffected (no
    # platform is actually touched).
    if live and not _in_human_hours(ist_h):
        msg = (
            f"It's outside normal hours right now (IST {ist_h}h) — I only search and apply "
            f"during the day ({HUMAN_HOURS_START}:00-{HUMAN_HOURS_END}:00 IST) to keep this "
            f"looking like a real person, not a bot running around the clock. Open the "
            f"dashboard and run again during the day."
        )
        log.info("deferred: outside human hours (IST %dh)", ist_h)
        notify.to_user(user, "Grindly: paused until daytime", f":clock3: {msg}")
        return {"deferred": "outside_human_hours", "hour_ist": ist_h}

    # 3. fetch listings — live platforms only (no mock/demo path)
    all_jobs: list[dict] = []
    source_modules: dict = {}
    # All platforms with a live session — distinct from the rotated subset we
    # *discover* on today. Approved-application submits (4a) and the
    # account-wide challenge breaker both need every connected platform, not
    # just today's rotation, so this is hoisted to function scope.
    connected_platforms: list[str] = db.get_connected_platforms(uid)

    if not connected_platforms:
        msg = (
            "no platforms connected. "
            "Connect a platform in the Integrations tab before running the agent."
        )
        log.warning(msg)
        return {"error": "no_platforms_connected", "message": msg}

    # A submit-only run does no discovery: the rotation exists to decide which
    # boards to *scrape* today, and there is nothing to scrape.
    active_sources = (
        [] if submit_only
        else _platforms_for_today(uid, [s for s in SOURCE_PRIORITY if s in connected_platforms])
    )
    if active_sources:
        log.info("platform rotation today: %s (connected: %s)", active_sources, connected_platforms)

    if not submit_only:
        kw_sets = _expand_search_keywords(plan["domains"], skills)
        per_kw = max(8, (cap + 5) // max(1, len(active_sources) * len(kw_sets)))

        # Load modules serially (importlib side-effects must stay single-threaded)
        loaded: dict[str, object] = {}
        for src in active_sources:
            mod = _load_module(src)
            if mod is not None:
                loaded[src] = mod

        # Fetch all platforms in parallel — each has isolated browser context per uid
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(loaded))) as ex:
            futs = {
                ex.submit(_fetch_source_all_kw, src, mod, kw_sets, per_kw, uid): src
                for src, mod in loaded.items()
            }
            for fut in concurrent.futures.as_completed(futs):
                src_done = futs[fut]
                try:
                    _, src_jobs = fut.result()
                    all_jobs.extend(src_jobs)
                    source_modules[src_done] = loaded[src_done]
                except Exception as e:  # noqa: BLE001
                    log.error("%s parallel fetch error: %s", src_done, e)

        log.info("total fetched: %d listings across all sources", len(all_jobs))

    # 4. score + apply within firewall + daily cap
    # Wipe the previous verdict on anything we just re-fetched, so a re-run
    # replaces a stale skip instead of stacking a second row beside it. Paired
    # with applied_external_ids() no longer treating a skip as final, this is
    # what lets a scoring fix (or an updated resume) reach jobs the agent had
    # already dismissed once.
    if all_jobs:
        dropped = db.clear_skipped(uid, [j.get("url", "") for j in all_jobs])
        if dropped:
            log.info("re-scoring %d listing(s) previously skipped", dropped)

    already = db.applied_external_ids(uid)
    applied_today = db.todays_applied_count(uid)
    day_remaining = max(0, cap - applied_today)
    # safety: never exceed the per-run cap even if the plan/day cap is higher
    remaining = (
        min(day_remaining, SAFETY_CAP_PER_RUN) if SAFETY_CAP_PER_RUN > 0 else day_remaining
    )
    if remaining < day_remaining:
        log.info("per-run safety cap active: %d (plan/day allows %d)", remaining, day_remaining)

    matched = applied = failed = 0
    letter_cache: dict[tuple[str, str], str] = {}
    applied_keys: set[tuple[str, str]] = set()
    per_src_applied: dict[str, int] = {}   # per-platform applies this run (bot-pace guard)
    per_src_failed:  dict[str, int] = {}   # per-platform failures this run (reliability monitor)
    needs_login_srcs: set[str] = set()     # platforms whose session died mid-run
    challenged_srcs: set[str] = set()      # platforms that flagged a captcha/challenge this run

    def _platform_blocked(src: str) -> bool:
        """True if this platform should be skipped: challenged already this run,
        or still cooling down from a challenge on a previous run."""
        if src in challenged_srcs:
            return True
        return _cooldown_active(db.get_integration(uid, src), db.time_ago_db(CHALLENGE_COOLDOWN_MS))

    def _flag_challenge(src: str):
        challenged_srcs.add(src)
        db.set_integration_status(uid, src, "challenge_detected")
        db.add_audit("challenge_detected", user_id=uid, target=src)
        log.warning("challenge/captcha on %s — pausing this platform for the rest of the run", src)

        # Account-wide pause: a challenge on one platform often means the
        # automation pattern itself got noticed, not just that one site's
        # rules — treat it as a signal about this account, not this site.
        # Flags EVERY connected platform (not just today's rotated subset),
        # so the cross-run cooldown applies account-wide the way the name
        # says — a platform not touched today still gets paused on its next
        # rotation. Reuses the same per-platform block/cooldown machinery.
        for other in connected_platforms:
            if other != src and other not in challenged_srcs:
                challenged_srcs.add(other)
                db.set_integration_status(uid, other, "challenge_detected")
                db.add_audit("challenge_detected", user_id=uid, target=other,
                             detail=f"account-wide pause triggered by {src}")
        if len(challenged_srcs) > 1:
            log.warning("account-wide pause: %s flagged, also pausing %s",
                       src, sorted(challenged_srcs - {src}))

    _FAIL_RATE_WARN = 0.5   # warn when >50% of attempts on a platform fail

    # Tailored resume cache: title_key -> (pdf_path | None, resume_version_id | None)
    tailor_cache: dict[str, tuple[str | None, str | None]] = {}
    _tailored_dir = os.path.join(_ROOT_DIR, "data", "tailored", uid)

    def _get_resume(title: str, company: str, job_skills: list[str], jd_text: str = "") -> tuple[str | None, str | None]:
        """Build (or reuse) the tailored resume for this role and record an
        immutable ResumeVersion snapshot. Returns (pdf_path, version_id) so the
        application row can point at the exact resume the recruiter received."""
        if not text or not live:
            return None, None
        tkey = _tailor_key(title)
        if tkey in tailor_cache:
            return tailor_cache[tkey]
        tailored_text = resume_ai.tailor(text, title, company, job_skills,
                                         job_description=jd_text, master_skills=skills)
        pdf = os.path.join(_tailored_dir, f"{tkey}.pdf")
        ok = resume_ai.to_pdf(tailored_text, pdf)
        pdf_path = pdf if ok else None
        try:
            vid = db.add_resume_version(
                uid,
                label=f"{title} @ {company}",
                job_title=title,
                company=company,
                text=tailored_text,
                file_path=pdf_path,
                skills_claimed=safety.skills_claimed(tailored_text, skills),
                base_skills=skills,
            )
        except Exception as e:  # noqa: BLE001
            log.warning("resume snapshot failed: %s", e)
            vid = None
        tailor_cache[tkey] = (pdf_path, vid)
        return tailor_cache[tkey]

    # 4a. Handle pre-approved applications (auto_apply=False users who manually approved)
    approved_apps = db.get_approved_applications(uid)
    if live and approved_apps:
        for app_row in approved_apps:
            if remaining <= 0:
                break
            src = app_row.get("source") or ""
            # A user tapped Approve on this — it MUST send, regardless of
            # today's discovery rotation. Rotation only limits which sites we
            # *scrape* for new jobs; it must never strand an already-approved
            # application (that would silently break the one-tap promise).
            # So load the platform module on demand for any connected
            # platform, even one not in today's rotated source_modules.
            if src not in connected_platforms:
                # Platform genuinely not connected (session gone / never set) —
                # can't submit; leave it approved for a run where it's connected.
                continue
            mod = source_modules.get(src)
            if mod is None:
                mod = _load_module(src)
                if mod is None:
                    continue
                source_modules[src] = mod  # so end-of-run close() cleans it up too
            if _platform_blocked(src):
                db.update_application_status(
                    app_row["id"], "matched", f"{src} paused — captcha/challenge cooldown active",
                )
                continue
            job = {
                "source": src,
                "external_id": app_row.get("external_id") or "",
                "title": app_row["job_title"],
                "company": app_row["company"],
                "url": app_row["url"] or "",
                "skills": json.loads(app_row.get("skills") or "[]"),
            }
            mod = source_modules[src]
            jd_text = _scrape_jd_if_available(src, mod, job["url"], uid)
            letter_key = (job["title"], job["company"])
            if letter_key not in letter_cache:
                letter_cache[letter_key] = cover_letter(name, job["title"], job["company"], skills, job, jd_text=jd_text)
            letter = letter_cache[letter_key]
            resume_path, vid = _get_resume(job["title"], job["company"], job["skills"], jd_text=jd_text)
            try:
                status, why = mod.apply(job, letter, uid, profile=profile, resume_path=resume_path)
            except Exception as e:  # noqa: BLE001
                status, why = "failed", f"exception: {str(e)[:100]}"
            fr = _classify_failure(why) if status == "failed" else None
            if fr == safety.FAILURE_REASON.CAPTCHA:
                _flag_challenge(src)
            db.update_application_status(
                app_row["id"], status, why, resume_version_id=vid, failure_reason=fr
            )
            db.add_audit("apply", user_id=uid, target=job.get("url"),
                         detail=f"{src}:{status}")
            already.add(job["url"])
            if status == "applied":
                applied += 1
                remaining -= 1
                per_src_applied[src] = per_src_applied.get(src, 0) + 1
                applied_keys.add((job["company"].lower(), job["title"].lower()[:40]))
            elif status == "failed":
                # Count approve-queue failures too, so the daily report and the
                # per-platform fail-rate monitor reflect reality.
                failed += 1
                per_src_failed[src] = per_src_failed.get(src, 0) + 1
            time.sleep(random.uniform(*_BASE_PACE_SEC))

    # 4b. Score fresh listings
    scored = []
    for job in all_jobs:
        if job["url"] in already:
            continue
        score, reason = matcher.score_job(
            job, skills, plan["domains"], exp_level=plan["exp_level"]
        )
        scored.append((score, reason, job))
    scored.sort(key=lambda x: x[0], reverse=True)

    # Re-score the strongest candidates against the REAL job description.
    #
    # A listing card carries only a title, so the role's requirements are a guess
    # inferred from that title. The JD is the one signal that can correct it — and
    # it used to be fetched only *after* a job had already cleared the threshold,
    # so it could never rescue a borderline listing, only decorate one that had
    # already won. Reading the JD of the few most promising listings before
    # deciding is also just what a person does.
    #
    # Bounded to JD_RESCORE_LIMIT page loads, paced like the rest of the run.
    if live and scored and JD_RESCORE_LIMIT > 0:
        for i in range(min(JD_RESCORE_LIMIT, len(scored))):
            _, _, job = scored[i]
            src = job.get("source", "")
            mod = source_modules.get(src)
            if mod is None or _platform_blocked(src):
                continue
            jd = _scrape_jd_if_available(src, mod, job.get("url", ""), uid)
            if not jd:
                continue
            job["jd_text"] = jd   # reused at apply time; never scrape the same JD twice
            scored[i] = matcher.score_job(
                job, skills, plan["domains"], exp_level=plan["exp_level"], jd_text=jd
            ) + (job,)
            time.sleep(random.uniform(*_BASE_PACE_SEC))
        scored.sort(key=lambda x: x[0], reverse=True)
        log.info("re-scored top %d listing(s) against their job descriptions",
                 min(JD_RESCORE_LIMIT, len(scored)))

    for score, reason, job in scored:
        dedup_key = (job["company"].lower(), job["title"].lower()[:40])
        if dedup_key in applied_keys:
            db.add_application(
                uid, job_id=None, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped",
                reason="duplicate: applied to same role via another platform", applied=False,
            )
            continue

        block = matcher.firewall_block(job, profile)
        job_id = db.upsert_job(job)
        src = job.get("source", "mock")

        if block:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped",
                reason=f"firewall: {block}", applied=False,
            )
            continue

        if score < plan["min_match_score"]:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped",
                reason=f"{reason} (below {plan['min_match_score']})", applied=False,
            )
            continue

        matched += 1

        if _requires_approval(src, plan["auto_apply"]):
            approval_reason = (
                f"{reason} — ready to send, tap Approve (final step is manual "
                f"on {src} to keep your account safe)"
                if src in ADVERSARIAL_PLATFORMS
                else f"{reason} — awaiting your OK"
            )
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=approval_reason, applied=False,
            )
            continue

        if remaining <= 0:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — daily cap reached", applied=False,
            )
            continue

        if _platform_blocked(src):
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — {src} paused (captcha/challenge cooldown)", applied=False,
            )
            continue

        # per-platform safety cap — keep a human-like pace on any one platform
        if SAFETY_CAP_PER_PLATFORM > 0 and per_src_applied.get(src, 0) >= SAFETY_CAP_PER_PLATFORM:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — {src} per-run cap ({SAFETY_CAP_PER_PLATFORM}) reached",
                applied=False,
            )
            continue

        # apply
        if live and src in source_modules:
            mod = source_modules[src]
            # JD text enriches the cover letter and the resume tailoring. The
            # top candidates already had theirs fetched (and were scored on it)
            # in 4b — reuse that rather than loading the page a second time.
            jd_text = job.get("jd_text") or _scrape_jd_if_available(src, mod, job["url"], uid)
            letter_key = (job["title"], job["company"])
            if letter_key not in letter_cache:
                letter_cache[letter_key] = cover_letter(
                    name, job["title"], job["company"], skills, job, jd_text=jd_text
                )
            letter = letter_cache[letter_key]
            resume_path, vid = _get_resume(job["title"], job["company"], job.get("skills", []), jd_text=jd_text)
            try:
                status, why = mod.apply(
                    job, letter, uid, profile=profile, resume_path=resume_path
                )
                # Retry ONLY on clearly pre-submit failures (missing selector /
                # element). A "timeout" can fire AFTER the submit click went
                # through, so retrying it would file a SECOND real application.
                if status == "failed" and any(
                    k in why.lower() for k in ("selector", "not found", "element")
                ) and "timeout" not in why.lower():
                    time.sleep(random.randint(15, 40))
                    status, why = mod.apply(job, letter, uid, profile=profile, resume_path=resume_path)
            except Exception as e:  # noqa: BLE001
                status, why = "failed", f"exception: {str(e)[:100]}"
        else:
            # No live module loaded for this listing's platform — never fabricate
            # an apply. Shortlist it so nothing fake reaches the dashboard.
            status, why, vid = "skipped", f"{src} unavailable this run", None

        if status == "applied":
            applied += 1
            remaining -= 1
            per_src_applied[src] = per_src_applied.get(src, 0) + 1
            applied_keys.add(dedup_key)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="applied", reason=why, applied=True,
                resume_version_id=vid,
            )
            db.add_audit("apply", user_id=uid, target=job.get("url"), detail=f"{src}:applied")
            if _SPREAD_APPLIES and remaining > 0:
                gap = random.randint(*_SPREAD_GAP_SEC)
                log.info("spread mode: sleeping %ds before next apply", gap)
                time.sleep(gap)
        elif status == "login_required":
            db.set_integration_status(uid, src, "needs_login")
            needs_login_srcs.add(src)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{why} — reconnect in dashboard", applied=False,
                failure_reason=safety.FAILURE_REASON.SESSION_EXPIRED,
            )
            db.add_audit("session_expired", user_id=uid, target=src)
        elif status == "skipped":
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped", reason=why, applied=False,
            )
        elif status == "needs_review":
            # Submit click registered but we couldn't confirm the outcome — do NOT
            # count this as a success (would misreport accuracy) or a failure
            # (would skew the per-platform fail-rate warning). Spend the daily
            # budget slot and dedup it like a real attempt so we never re-click
            # an already-submitted form, but surface it for the user to verify.
            remaining -= 1
            per_src_applied[src] = per_src_applied.get(src, 0) + 1
            applied_keys.add(dedup_key)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="needs_review", reason=why,
                applied=False, resume_version_id=vid,
            )
            db.add_audit("apply_needs_review", user_id=uid, target=job.get("url"), detail=why[:120])
        else:
            failed += 1
            per_src_failed[src] = per_src_failed.get(src, 0) + 1
            fr = _classify_failure(why)
            if fr == safety.FAILURE_REASON.CAPTCHA:
                _flag_challenge(src)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="failed", reason=why, applied=False,
                resume_version_id=vid, failure_reason=fr,
            )
            db.add_audit("apply_failed", user_id=uid, target=job.get("url"), detail=why[:120])

        if live:
            time.sleep(random.uniform(*_BASE_PACE_SEC))

    # per-platform failure rate check — warn if >50% of attempts on a platform fail
    for src in set(list(per_src_applied) + list(per_src_failed)):
        attempts = per_src_applied.get(src, 0) + per_src_failed.get(src, 0)
        if attempts >= 3:
            rate = per_src_failed.get(src, 0) / attempts
            if rate > _FAIL_RATE_WARN:
                log.warning(
                    "HIGH FAILURE RATE on %s: %d/%d (%d%%) — selectors may be broken or site changed",
                    src, per_src_failed.get(src, 0), attempts, int(rate * 100),
                )
                db.add_audit("high_failure_rate", user_id=uid, target=src,
                             detail=f"{int(rate*100)}% fail rate ({attempts} attempts)")
                notify.send(
                    _OPS_CHANNEL,
                    f":warning: High failure rate on *{src}*: {per_src_failed.get(src, 0)}/{attempts} "
                    f"({int(rate*100)}%) for user {uid} — selectors may be broken or the site changed.",
                )

    # close browser contexts
    if live:
        for src, mod in source_modules.items():
            try:
                mod.close(uid)
            except Exception:  # noqa: BLE001
                pass

    # urgent: session(s) died mid-run — user must reconnect or the agent stalls
    if needs_login_srcs:
        notify.to_user(
            user,
            "Grindly: reconnect needed",
            f":warning: *Action needed* — your session expired on "
            f"{', '.join(sorted(needs_login_srcs))}. Reconnect in the dashboard so "
            f"I can keep applying. (Pending matches are saved.)",
        )
        db.add_audit("notify_urgent", user_id=uid,
                     detail=f"needs_login: {','.join(sorted(needs_login_srcs))}")

    # heads-up: a platform flagged us as a bot mid-run — paused, not stalled
    if challenged_srcs:
        notify.to_user(
            user,
            "Grindly: paused after an automation check",
            f":large_orange_diamond: I paused applying on "
            f"{', '.join(sorted(challenged_srcs))} after it flagged an automation "
            f"check — safer to back off than push through. Retrying automatically "
            f"after a cooldown.",
        )

    # A submit-only run sends the applications the user just approved and stops.
    # It isn't a sweep, so it must not file a daily report (that would overwrite
    # the day's real numbers with matched=0) or repeat the daily digest.
    if submit_only:
        log.info("done (approved submits): applied=%d failed=%d", applied, failed)
        if applied or failed:
            notify.to_user(
                user,
                "Grindly: your approved applications are in",
                f":white_check_mark: Sent *{applied}* application(s) you approved."
                + (f"  ({failed} couldn't be submitted — see the dashboard.)" if failed else ""),
            )
        return {"applied": applied, "matched": 0, "failed": failed, "mode": "approved"}

    # 5. report + 6. notify
    today = datetime.date.today().isoformat()
    top = sorted(scored, key=lambda x: x[0], reverse=True)[:3]
    top_lines = "\n".join(
        f"  • {j['title']} @ {j['company']} [{j.get('source','?')}] — match {s}"
        for s, _, j in top
    )
    summary = (
        f"Applied to {applied} internship(s) today, shortlisted {matched}.\n"
        f"Top matches:\n{top_lines}"
        if top
        else f"Applied to {applied}, shortlisted {matched}."
    )
    db.add_report(uid, date=today, matched=matched, applied=applied, failed=failed,
                  summary=summary, delivered=True)

    sources_used = ", ".join(source_modules.keys()) if source_modules else "mock board"
    approve_nudge = (
        "\n\n:point_right: I don't auto-submit on LinkedIn/Internshala/Naukri/Unstop/Indeed "
        "— that's what keeps your account safe. Open the dashboard and tap *Approve* on "
        "your matches to send them."
        if matched > applied
        else ""
    )
    msg = (
        f":robot_face: *Grindly daily report — {today}*\n"
        f":white_check_mark: Applied: *{applied}*  ·  :star: Shortlisted: {matched}  ·  "
        f":x: Failed: {failed}\n"
        f"Sources: {sources_used}\n\n"
        f"{summary}\n\nNext sweep in 24h. Pause anytime from the dashboard.{approve_nudge}"
    )
    notify.to_user(user, f"Grindly daily report — {today}", msg)
    log.info("done: applied=%d matched=%d failed=%d", applied, matched, failed)
    return {"applied": applied, "matched": matched, "failed": failed}


def run_job(uid: str, mode: str) -> dict:
    """Queue dispatcher so the web app can ENQUEUE work instead of spawning
    Python itself:
      'analyze'              → resume analysis only
      'connect_<platform>'   → credential login for that platform (hosted)
      'approved'             → submit only the applications the user approved
      anything else          → full apply pipeline.
    Used by both --drain and --serve."""
    if mode == "analyze":
        return analyze_only(uid)
    if mode.startswith("connect"):
        # mode is "connect_internshala" (or legacy "connect" → internshala)
        platform = mode.split("_", 1)[1] if "_" in mode else "internshala"
        import connect_login
        return connect_login.login(uid, platform)
    return run_for_user(uid, mode)


def main():
    import run_queue

    ap = argparse.ArgumentParser()
    ap.add_argument("--user")
    ap.add_argument("--mode", default="live", choices=["live", "approved"])
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--analyze", action="store_true", help="Resume analyze only — no job scraping")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--drain", action="store_true", help="Claim + run all queued agent_runs, then exit")
    ap.add_argument("--serve", action="store_true", help="Drain the run queue in a loop")
    ap.add_argument("--interval", type=int, default=86400)
    args = ap.parse_args()

    worker_id = f"w-{os.getpid()}"

    if args.drain:
        n = run_queue.drain(worker_id, run_job)
        log.info("drained %d job(s)", n)
    elif args.serve:
        run_queue.serve(worker_id, run_job, interval=10)
    elif args.loop:
        log.info("service mode: sweeping active users")
        while True:
            for uid in db.active_users():
                try:
                    run_for_user(uid, args.mode)
                except Exception as e:  # noqa: BLE001
                    log.error("user %s failed: %s", uid, e)
            time.sleep(args.interval)
    elif args.user:
        if args.analyze:
            analyze_only(args.user)
        else:
            run_for_user(args.user, args.mode)
    else:
        log.warning("specify --user <uid> [--mode live|approved] [--analyze], --drain, --serve, or --loop")


if __name__ == "__main__":
    main()
