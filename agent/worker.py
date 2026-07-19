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

Quota: free = 5/day   plus = 5/day   pro = 15/day   (all reset daily)

Usage:
  python worker.py --user <uid> --mode live --once
  python worker.py --user <uid> --analyze          # resume analyze only, no jobs
  python worker.py --loop                           # service mode: sweep all active users
"""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
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
import latex_resume
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
    if "upload" in w or ("resume" in w and "fail" in w):
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
    applications a day, never more than the plan allowance. Seeded by
    uid+date so repeat runs the same day don't reroll, but the number varies
    day to day and user to user — an identical count every single day is
    itself a bot signal. Never exceeds the plan's own cap."""
    today = today or datetime.date.today().isoformat()
    rng = random.Random(f"{uid}:{today}:cap")
    # Scale the human-pace band with the plan so Pro (15/day) genuinely
    # applies to more than Plus (5/day). Previously this was a flat
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
    """True when discovery must stop before final platform submission.

    Safe Apply Mode fails closed for every browser source, including an
    unrecognised future source.  The profile setting controls whether the agent
    prepares matches, never whether it may impersonate a user at final submit.
    """
    del auto_apply
    return safety.requires_manual_final_submit(src)[0]


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

# One discovery sweep is meant to find roughly a MONTH of work, not a day of it,
# and then drip it out. Two reasons, and the second is the important one:
#
#   1. Scraping five job boards every single day, for every user, is a lot of
#      traffic to sites that are actively watching for exactly that pattern.
#      Filling the queue once and living off it is quieter.
#   2. The user must never see the whole pile. If the dashboard showed 300 matched
#      listings, the rational move is to close the tab and go apply to them by
#      hand — we would have done the expensive part (finding them) and captured
#      none of the value. So matches are banked with a scheduled_for date and only
#      the ones due today are ever sent to the client.
PIPELINE_DAYS = int(os.environ.get("GRINDLY_PIPELINE_DAYS", "30"))

# ...and we only go back to the boards once the queue has genuinely run down.
#
# This needs hysteresis, and the obvious version doesn't have it: "refill unless
# the pipeline is full" means approving a single application drops the depth below
# full and triggers a fresh scrape of all five boards on the next sweep. The
# pipeline would refill every single day — precisely the traffic pattern it exists
# to prevent. So: fill to PIPELINE_DAYS, but don't refill until under
# PIPELINE_REFILL_DAYS.
PIPELINE_REFILL_DAYS = int(os.environ.get("GRINDLY_PIPELINE_REFILL_DAYS", "7"))
_DAY_MS = 86_400_000
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


def _tailor_key(title: str, company: str = "") -> str:
    """Cache key for a tailored resume. Includes the company: two listings can
    share a title ("Web Development Internship" is on Internshala a hundred times)
    while asking for very different things, and reusing one company's tailored
    resume for another is exactly the kind of silent wrongness nobody would catch."""
    raw = f"{title.lower()[:30]}_{company.lower()[:20]}"
    return re.sub(r"[^a-z0-9]+", "_", raw).strip("_")


def _schedule_day(slot: int, cap: int, days: int = PIPELINE_DAYS) -> int:
    """Which 24-hour batch (0 = current batch) a queue position belongs to."""
    cap = max(1, cap)
    days = max(1, days)
    # Each batch contains at most the user's plan cap. Past the horizon, retain
    # the final batch rather than releasing an unbounded backlog.
    if slot >= cap * days:
        return days - 1
    return slot // cap


def _release_at(slot: int, cap: int, now: datetime.datetime | None = None):
    """When a queue position comes due. A whole batch is released together at its
    24-hour boundary: batch 0 (today's cap) is due immediately, batch 1 in 24h,
    and so on.

    We used to also stagger the `cap` slots WITHIN a batch across its 24 hours
    (lane * day / cap). But the agent never auto-submits — the user opens and
    submits every match by hand — so a visibility trickle bought no anti-bot value
    and had a real cost: for most of every day the dashboard showed "0 matched"
    even right after a successful run, which users read as the agent having
    stopped. Releasing the batch together means a run yields visible matches now,
    and each new day surfaces the day's full batch at once. The per-DAY cap — the
    thing that actually prevents a same-day mass-apply — is unchanged: still at
    most `cap` matches become visible per day."""
    cap = max(1, cap)
    batch = _schedule_day(slot, cap)
    delay_ms = batch * _DAY_MS
    if now is None:
        return db.time_from_now_db(delay_ms)
    return now + datetime.timedelta(milliseconds=delay_ms)


def deliver_ready_match(uid: str, user: dict) -> dict:
    """Send one final application link. It never contacts a job platform."""
    app = db.next_due_unnotified_match(uid)
    if not app:
        return {"delivered": 0}
    source = app.get("source") or "job platform"
    text = (
        f":link: *Your next match is ready*\n"
        f"*{app['job_title']}* at *{app['company']}* ({app['match_score']} match)\n"
        f"Open: {app['url']}\n\n"
        f"Complete the final Apply/Submit step yourself on {source}. Then return to "
        "Grindly and mark it submitted so your daily limit and outcome tracking stay accurate."
    )
    if not notify.to_user(user, "Grindly: your next application link is ready", text):
        return {"delivered": 0, "undelivered": 1}
    if not db.mark_match_notified(app["id"]):
        return {"delivered": 0, "already_notified": 1}
    db.add_audit("application_link_delivered", user_id=uid, target=app["url"], detail=source)
    return {"delivered": 1, "application_id": app["id"]}


def _resume_hash(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8", "replace")).hexdigest()


def _analyze_if_changed(uid: str, profile: dict, text: str, skills: list[str],
                        force: bool = False) -> dict | None:
    """Score the resume, but only when there is something new to score.

    Returns the analysis if one was computed, None if the cached one still stands.
    `force=True` is the user pressing "re-analyze" — they get a fresh answer even
    if nothing changed, because that button has to do something.
    """
    h = _resume_hash(text)
    if not force and h == (profile.get("resume_hash") or "") and profile.get("resume_score") is not None:
        log.info("resume unchanged — reusing the stored analysis (score %s)",
                 profile.get("resume_score"))
        return None

    # with_ats() folds in the mechanical extraction check and caps the score when a
    # parser can't read the file. A beautifully written resume that no ATS can read
    # is not an 82/100 resume, whatever the model thinks of the prose.
    analysis = resume_ai.with_ats(resume_ai.analyze(text), text, skills)
    db.set_resume_analysis(uid, analysis["score"], json.dumps(analysis), resume_hash=h)
    log.info(
        "resume score: %d/100 (%s) — %d issue(s), ats_readable=%s",
        analysis["score"], analysis["grade"], len(analysis["issues"]),
        analysis["ats"]["readable"],
    )
    return analysis


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

    # force=True: this path is the user pressing "Re-analyze", and a button that
    # silently reuses a cached answer is a broken button.
    return _analyze_if_changed(uid, profile, text, skills, force=True) or {}


def latex_check(uid: str) -> dict:
    """Compile the user's UNEDITED .tex and decide whether tailoring can work at all.

    Runs once, at upload. Everything it catches would otherwise fail silently and
    permanently at apply time: compile_pdf() would return False, the master resume
    would go out untouched, and the user would never learn that the file they
    uploaded is doing nothing. Better to say so while they're still looking at the
    upload screen.

    Also establishes the page-count baseline the per-job tailoring is later judged
    against — if compiling the untouched source already yields a different page
    count than their master PDF, then the .tex and the PDF are not the same
    document, and no edit to it can be trusted.
    """
    tex = latex_resume.read_tex(uid)
    if not tex:
        db.set_tex_status(uid, "missing", "No .tex on file.")
        return {"status": "missing"}

    def _fail(status: str, detail: str) -> dict:
        log.warning("latex check for %s: %s — %s", uid, status, detail)
        db.set_tex_status(uid, status, detail)
        return {"status": status, "detail": detail}

    bad = latex_resume.unsafe_commands(tex)
    if bad:
        return _fail("unsafe", f"This .tex uses commands we won't run on the server: {', '.join(bad)}.")

    sections = latex_resume.editable_sections(tex)
    if not sections:
        return _fail(
            "no_sections",
            "We couldn't find a Skills or Hobbies section in this file, so there's "
            "nothing we're allowed to tailor. Your resume will still be sent — just "
            "unchanged.",
        )

    if not latex_resume.tectonic_available():
        return _fail("no_compiler", "The LaTeX compiler isn't available on this server yet.")

    out = os.path.join(_ROOT_DIR, "data", "tailored", uid, "_baseline.pdf")
    if not latex_resume.compile_pdf(tex, out):
        return _fail(
            "compile_failed",
            "This .tex didn't compile. Make sure it's the complete source (including "
            "\\documentclass and \\begin{document}), not a fragment.",
        )

    pages = latex_resume.page_count(out)
    master = resume_parse.find_resume_file(uid)
    master_pages = (
        latex_resume.page_count(master)
        if master and master.lower().endswith(".pdf") else None
    )
    if master_pages and pages and master_pages != pages:
        return _fail(
            "page_mismatch",
            f"Your .tex compiles to {pages} page(s) but your uploaded resume is "
            f"{master_pages}. They look like different documents — upload the .tex "
            f"that produced the PDF you're sending.",
        )

    detail = f"Ready. The agent may edit: {', '.join(sorted(sections))}."
    log.info("latex check for %s: ok (%s)", uid, detail)
    db.set_tex_status(uid, "ok", detail)
    return {"status": "ok", "sections": sorted(sections), "pages": pages}


def run_for_user(uid: str, mode: str = "live", manual: bool = False) -> dict:
    user = db.get_user(uid)
    if not user:
        log.warning("no user %s", uid)
        return {"error": "no user"}

    profile = user.get("profile") or {}
    name = user.get("name") or (user.get("email") or "").split("@")[0]

    # "approved" is retained only to drain legacy queued work safely.  Safe
    # Apply Mode never submits from this worker; current dashboard approvals do
    # not enqueue this mode.
    submit_only = mode == "approved"
    live = mode in ("live", "approved")

    user_plan = db.get_user_plan(uid)
    plan_cap = db.get_plan_cap(uid)
    # Free beta: free is a DAILY plan (5/day), same shape as paid — human-paced
    # and counted per day. No lifetime trial, so it resets each day like Plus/Pro.
    cap = _daily_cap_for_today(uid, plan_cap)
    quota_used = db.todays_applied_count(uid)
    quota_kind = "today"
    log.info("=== run for %s (%s) mode=%s cap=%d used=%d (%s) ===", name, uid, mode, cap, quota_used, quota_kind)
    db.add_audit("run_start", user_id=uid, detail=f"mode={mode} cap={cap}")
    if mode == "deliver":
        return deliver_ready_match(uid, user)
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

    # 1.5 Resume analysis — only when the resume actually changed.
    #
    # This used to run unconditionally on every sweep: a full LLM call, every day,
    # to re-score a resume that was byte-identical to yesterday's. The hash is the
    # whole fix.
    if text:
        _analyze_if_changed(uid, profile, text, skills)

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
    #
    # `manual` runs bypass it: the user tapped "Run agent" and is sitting on the
    # dashboard right now. Deferring their explicit click looked identical to a
    # broken agent ("0 ready, 0 sent" with no reason). It is also safe — Safe
    # Apply Mode means a live run only DISCOVERS and banks matches for the user
    # to submit themselves (see _requires_approval); nothing is auto-submitted at
    # any hour, so odd-hour discovery carries none of the risk this gate guards.
    # The scheduled/background sweep (manual=False) stays gated.
    if live and not manual and not _in_human_hours(ist_h):
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

    # Don't re-scrape while the queue still holds real work. Going back to five job
    # boards for listings we have no free day to send anyway is pure noise — to them
    # and to us — and daily scraping is itself the pattern they watch for.
    plan_cap = db.get_plan_cap(uid)
    pipeline = db.pipeline_depth(uid)
    refill_at = plan_cap * PIPELINE_REFILL_DAYS
    stocked = pipeline >= refill_at
    if stocked and not submit_only:
        log.info(
            "pipeline holds %d match(es) (~%d days of work, refill under %d) — "
            "skipping discovery this run",
            pipeline, pipeline // max(1, plan_cap), refill_at,
        )

    discover = not submit_only and not stocked

    # A submit-only run does no discovery: the rotation exists to decide which
    # boards to *scrape* today, and there is nothing to scrape.
    active_sources = (
        _platforms_for_today(uid, [s for s in SOURCE_PRIORITY if s in connected_platforms])
        if discover else []
    )
    if active_sources:
        log.info("platform rotation today: %s (connected: %s)", active_sources, connected_platforms)

    if discover:
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
    quota_remaining = max(0, cap - quota_used)
    # Safety: never exceed the per-run cap even if the daily cap is higher.
    # quota_used is today's count for every plan (free included), so the cap
    # resets tomorrow rather than being a lifetime ceiling.
    remaining = (
        min(quota_remaining, SAFETY_CAP_PER_RUN) if SAFETY_CAP_PER_RUN > 0 else quota_remaining
    )
    if remaining < quota_remaining:
        log.info("per-run safety cap active: %d (quota allows %d)", remaining, quota_remaining)

    matched = applied = failed = 0
    queued = 0   # matches banked into the pipeline THIS run (drives the due-date)
    letter_cache: dict[tuple[str, str], str] = {}
    # What the adapters get. The profile row alone lacks the candidate's name and
    # email, and agent/questions.py needs both to answer "Your name" / "Email"
    # fields from stored fact instead of letting a model guess at them.
    apply_profile = {**profile, "name": name, "email": user.get("email") or ""}
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

    # Tailored resume cache: key -> (pdf_path | None, resume_version_id | None)
    tailor_cache: dict[str, tuple[str | None, str | None]] = {}
    _tailored_dir = os.path.join(_ROOT_DIR, "data", "tailored", uid)
    master_pdf = resume_parse.find_resume_file(uid)
    # Only tailor from a .tex that PASSED its upload-time self-test (latex_check).
    # Trusting the file just because it exists is what made the failure silent:
    # a .tex that doesn't compile would be re-attempted, and re-fail, on every
    # single application forever, with the user told nothing either time.
    tex_ok = (profile.get("resume_tex_status") or "") == "ok"
    master_tex = latex_resume.read_tex(uid) if tex_ok else ""
    if not tex_ok and profile.get("resume_tex_name"):
        log.info(
            "skipping LaTeX tailoring: .tex self-test says %r",
            profile.get("resume_tex_status") or "not checked",
        )
    # Layout tripwire: the page count of the resume the user actually approved of.
    # Any edit that changes it has reflowed the document — which is precisely what
    # a college-mandated template forbids — so that edit gets thrown away.
    _baseline_pages: list[int | None] = []   # lazily filled, one-element cache

    def _master_pages() -> int | None:
        if not _baseline_pages:
            _baseline_pages.append(
                latex_resume.page_count(master_pdf)
                if master_pdf and master_pdf.lower().endswith(".pdf")
                else None
            )
        return _baseline_pages[0]

    # Neatness baseline: how many Overfull \hbox/\vbox the UNEDITED .tex already
    # has. Some college templates run a line slightly long by design; the test is
    # not "zero overfull boxes" but "the edit added none". Compiled once per run
    # (the master .tex is the same for every job), then cached.
    _baseline_overfull: list[int | None] = []

    def _master_overfull() -> int | None:
        if not _baseline_overfull:
            val: int | None = None
            if master_tex:
                r = latex_resume.compile_report(
                    master_tex, os.path.join(_tailored_dir, "_baseline.pdf")
                )
                val = r.overfull if r.ok else None
            _baseline_overfull.append(val)
        return _baseline_overfull[0]

    def _get_resume(
        title: str, company: str, job_skills: list[str], jd_text: str = ""
    ) -> tuple[str | None, str | None]:
        """Decide which resume this role gets, and record an immutable snapshot.

        Returns (pdf_path, resume_version_id) so the application row points at the
        exact document the recruiter received.

        The default is to change NOTHING. We only edit when the master resume
        genuinely under-sells the candidate for this role (fit_score below
        resume_ai.TAILOR_THRESHOLD) AND the user gave us the LaTeX source to edit
        safely. Every other path sends the master PDF untouched.

        There is no plain-text-to-PDF fallback any more. The old one re-rendered
        the whole resume with fpdf2, which threw away the user's college template
        — the exact "it looks patched together" failure this is meant to fix. A
        resume we cannot edit correctly is one we must not edit at all.
        """
        if not live:
            return None, None
        ckey = _tailor_key(title, company)
        if ckey in tailor_cache:
            return tailor_cache[ckey]

        fit = resume_ai.fit_score(text, {"title": title, "skills": job_skills}, jd_text)

        def _snapshot(path, doc_text, tailored, why):
            try:
                vid = db.add_resume_version(
                    uid,
                    label=f"{title} @ {company}",
                    job_title=title,
                    company=company,
                    text=doc_text,
                    file_path=path,
                    skills_claimed=safety.skills_claimed(doc_text, skills),
                    base_skills=skills,
                    tailored=tailored,
                    fit_score=fit,
                )
            except Exception as e:  # noqa: BLE001
                log.warning("resume snapshot failed: %s", e)
                vid = None
            log.info("resume for %s @ %s: %s (fit %d/100)", title, company, why, fit)
            tailor_cache[ckey] = (path, vid)
            return tailor_cache[ckey]

        # Good enough as-is — the commonest case, and the cheapest.
        if fit >= resume_ai.TAILOR_THRESHOLD:
            return _snapshot(master_pdf, text, False, "master, unchanged")

        if not master_tex:
            return _snapshot(
                master_pdf, text, False,
                "master, unchanged (no usable .tex — cannot edit without breaking the template)",
            )

        edited = resume_ai.tailor_latex(
            master_tex, title, company, job_skills,
            job_description=jd_text, master_skills=skills,
        )
        if not edited:
            return _snapshot(master_pdf, text, False, "master, unchanged (no safe edit found)")

        pdf = os.path.join(_tailored_dir, f"{ckey}.pdf")
        result = latex_resume.compile_report(edited, pdf)
        if not result.ok:
            return _snapshot(master_pdf, text, False, "master, unchanged (LaTeX compile failed)")

        def _discard(pdf_path: str, why: str):
            try:
                os.remove(pdf_path)
            except OSError:
                pass
            return _snapshot(master_pdf, text, False, why)

        # Alignment gate 1 — page count. An edit that changes it has reflowed the
        # document, which the college template forbids.
        want = _master_pages()
        got = result.pages
        if want and got and got != want:
            log.warning(
                "tailored resume for %s reflowed to %d page(s) (master is %d) — discarding the edit",
                title, got, want,
            )
            return _discard(pdf, "master, unchanged (edit changed the page count)")

        # Alignment gate 2 — neatness. Same page count can still mean a line now
        # spills past the margin (an Overfull box). Accept only if the edit added
        # none the master didn't already have.
        base_of = _master_overfull()
        if base_of is not None and result.overfull > base_of:
            log.warning(
                "tailored resume for %s introduced %d new overfull box(es) — not neat, discarding",
                title, result.overfull - base_of,
            )
            return _discard(pdf, "master, unchanged (edit broke the alignment)")

        return _snapshot(pdf, edited, True, "tailored (Skills/Hobbies only)")

    # 4a. Keep user-approved applications ready for the user's own final submit.
    # Safe Apply Mode never calls a platform adapter from this queue.  This guard
    # is intentionally before module loading so an accidental queue run cannot
    # log in, fill, or click any external application form.
    requeue_after_seconds = 0
    approved_apps = db.get_approved_applications(uid)
    if live and approved_apps:
        for approved_index, app_row in enumerate(approved_apps):
            if remaining <= 0:
                break
            src = app_row.get("source") or ""
            manual_final_submit, hold_reason = safety.requires_manual_final_submit(src)
            if manual_final_submit:
                db.update_application_status(app_row["id"], "approved", hold_reason)
                db.add_audit("safe_apply_hold", user_id=uid, target=app_row.get("url"), detail=src)
                continue
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
            rec: dict = {}
            try:
                status, why = mod.apply(
                    job, letter, uid, profile=apply_profile,
                    resume_path=resume_path, record=rec,
                )
            except Exception as e:  # noqa: BLE001
                status, why = "failed", f"exception: {str(e)[:100]}"
            fr = _classify_failure(why) if status == "failed" else None
            if fr == safety.FAILURE_REASON.CAPTCHA:
                _flag_challenge(src)
            if status == "skipped" and "closed" in why.lower():
                # The listing died between banking it and offering it — three weeks
                # is a long time for an internship posting. Backfill the day's batch
                # from the pipeline so a closed posting doesn't silently cost the
                # user an application they were owed.
                fr = safety.FAILURE_REASON.LISTING_CLOSED
                if db.promote_next_match(uid, 1):
                    log.info("listing closed — pulled the next queued match forward")
            db.update_application_status(
                app_row["id"], status, why, resume_version_id=vid, failure_reason=fr,
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
            )
            db.add_audit("apply", user_id=uid, target=job.get("url"),
                         detail=f"{src}:{status}")
            already.add(job["url"])
            if status == "applied":
                applied += 1
                remaining -= 1
                per_src_applied[src] = per_src_applied.get(src, 0) + 1
                applied_keys.add((job["company"].lower(), job["title"].lower()[:40]))
                if (
                    _SPREAD_APPLIES
                    and remaining > 0
                    and approved_index + 1 < len(approved_apps)
                ):
                    requeue_after_seconds = random.randint(*_SPREAD_GAP_SEC)
                    log.info(
                        "spread mode: yielding worker for %ds before next approved apply",
                        requeue_after_seconds,
                    )
                    break
            elif status == "needs_review" and (
                _SPREAD_APPLIES
                and remaining > 0
                and approved_index + 1 < len(approved_apps)
            ):
                remaining -= 1
                requeue_after_seconds = random.randint(*_SPREAD_GAP_SEC)
                log.info(
                    "spread mode: yielding worker for %ds after ambiguous submit",
                    requeue_after_seconds,
                )
                break
            elif status == "failed":
                # Count approve-queue failures too, so the daily report and the
                # per-platform fail-rate monitor reflect reality.
                failed += 1
                per_src_failed[src] = per_src_failed.get(src, 0) + 1
            time.sleep(random.uniform(*_BASE_PACE_SEC))

    if requeue_after_seconds:
        for src, mod in source_modules.items():
            try:
                mod.close(uid)
            except Exception:  # noqa: BLE001
                pass
        return {
            "applied": applied,
            "matched": 0,
            "failed": failed,
            "mode": mode,
            "_requeue_after_seconds": requeue_after_seconds,
        }

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
            # Bank it with a due date instead of dumping it on the dashboard.
            # `pipeline` is what was already queued before this run, so a second
            # sweep keeps filling days behind the existing queue rather than
            # piling another `cap` matches onto today.
            slot = pipeline + queued
            queued += 1
            approval_reason = f"{reason} — {safety.SAFE_APPLY_REASON}"
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=approval_reason, applied=False,
                scheduled_for=_release_at(slot, plan_cap),
                missing_skills=matcher.missing_skills(
                    job, skills, jd_text=job.get("jd_text", "")
                ),
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
            rec = {}
            try:
                status, why = mod.apply(
                    job, letter, uid, profile=apply_profile,
                    resume_path=resume_path, record=rec,
                )
                # Retry ONLY on clearly pre-submit failures (missing selector /
                # element). A "timeout" can fire AFTER the submit click went
                # through, so retrying it would file a SECOND real application.
                if status == "failed" and any(
                    k in why.lower() for k in ("selector", "not found", "element")
                ) and "timeout" not in why.lower():
                    time.sleep(random.randint(15, 40))
                    status, why = mod.apply(
                        job, letter, uid, profile=apply_profile,
                        resume_path=resume_path, record=rec,
                    )
            except Exception as e:  # noqa: BLE001
                status, why = "failed", f"exception: {str(e)[:100]}"
        else:
            # No live module loaded for this listing's platform — never fabricate
            # an apply. Shortlist it so nothing fake reaches the dashboard.
            status, why, vid, rec = "skipped", f"{src} unavailable this run", None, {}

        if status == "applied":
            applied += 1
            remaining -= 1
            per_src_applied[src] = per_src_applied.get(src, 0) + 1
            applied_keys.add(dedup_key)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="applied", reason=why, applied=True,
                resume_version_id=vid,
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
            )
            db.add_audit("apply", user_id=uid, target=job.get("url"), detail=f"{src}:applied")
            if _SPREAD_APPLIES and remaining > 0:
                requeue_after_seconds = random.randint(*_SPREAD_GAP_SEC)
                log.info(
                    "spread mode: yielding worker for %ds before next apply",
                    requeue_after_seconds,
                )
                break
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
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
            )
            db.add_audit("apply_needs_review", user_id=uid, target=job.get("url"), detail=why[:120])
            if _SPREAD_APPLIES and remaining > 0:
                requeue_after_seconds = random.randint(*_SPREAD_GAP_SEC)
                log.info(
                    "spread mode: yielding worker for %ds after ambiguous submit",
                    requeue_after_seconds,
                )
                break
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
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
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

    if requeue_after_seconds:
        return {
            "applied": applied,
            "matched": matched,
            "failed": failed,
            "mode": mode,
            "_requeue_after_seconds": requeue_after_seconds,
        }

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

    # A legacy submit-only run only preserves applications for the user's manual
    # completion.  It isn't a sweep, so it must not overwrite the daily report.
    if submit_only:
        log.info("done (safe-apply holds): prepared=%d", len(approved_apps))
        return {"applied": applied, "matched": 0, "failed": failed, "mode": "approved"}

    # 5. report + 6. notify
    #
    # The report talks about what the user can ACT on today, not about the size of
    # the pipeline. Telling them "we found 300 jobs" invites them to go ask for the
    # list — and the list is the product.
    today = datetime.date.today().isoformat()
    ready = db.ready_today_count(uid)
    depth = db.pipeline_depth(uid)
    summary = (
        f"Recorded {applied} submitted internship(s) today. "
        f"{ready} more ready for you to prepare. "
        f"{depth} lined up over the coming weeks."
    )
    db.add_report(uid, date=today, matched=matched, applied=applied, failed=failed,
                  summary=summary, delivered=True)

    sources_used = ", ".join(source_modules.keys()) if source_modules else "your queue"
    approve_nudge = (
        "\n\n:point_right: I don't click the final submit on LinkedIn/Internshala/Naukri/"
        "Unstop/Indeed. Open the dashboard, prepare a match, then complete the "
        "final submission in your own browser."
        if ready
        else ""
    )
    msg = (
        f":robot_face: *Grindly daily report — {today}*\n"
        f":white_check_mark: Applied: *{applied}*  ·  :inbox_tray: Ready for you: {ready}  ·  "
        f":x: Failed: {failed}\n"
        f"Sources: {sources_used}\n\n"
        f"{summary}\n\nI'll keep working through your queue. Pause anytime from the "
        f"dashboard.{approve_nudge}"
    )
    # A report nobody receives is the same as no agent at all, so an undeliverable
    # one is an operational failure, not a cosmetic one. Say so loudly — the whole
    # point of the delivered flag is that a mute production install stops looking
    # exactly like a working one.
    if not notify.to_user(user, f"Grindly daily report — {today}", msg):
        log.error(
            "daily report UNDELIVERED for %s — the user has no working channel", uid
        )
        db.add_audit("report_undelivered", user_id=uid, detail=f"date={today}")
        notify.send(
            _OPS_CHANNEL,
            f":rotating_light: Daily report undeliverable for user `{uid}`. "
            f"SMTP configured: {notify.email_notify.configured()}. "
            f"Slack configured: {notify.slack_configured()}.",
        )

    log.info(
        "done: applied=%d matched=%d queued=%d ready_today=%d pipeline=%d failed=%d",
        applied, matched, queued, ready, depth, failed,
    )
    return {
        "applied": applied,
        "matched": matched,
        "queued": queued,
        "ready": ready,
        "pipeline": depth,
        "failed": failed,
    }


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
    if mode == "latex_check":
        return latex_check(uid)
    if mode.startswith("connect"):
        # mode is "connect_internshala" (or legacy "connect" → internshala)
        platform = mode.split("_", 1)[1] if "_" in mode else "internshala"
        import connect_login
        return connect_login.login(uid, platform)
    # Jobs drained from the queue skip the human-hours defer (manual=True). The
    # web app enqueues these on a "Run agent" tap, and deferring an explicit
    # click read as a broken agent. It's safe: Safe Apply Mode means a live run
    # only discovers + banks matches for the user to submit, never auto-submits,
    # so there is no odd-hour submission to gate. Only the legacy --loop/direct
    # CLI paths (run_for_user called directly, manual=False) stay gated.
    return run_for_user(uid, mode, manual=True)


def main():
    import run_queue

    ap = argparse.ArgumentParser()
    ap.add_argument("--user")
    ap.add_argument("--mode", default="live", choices=["live", "approved", "deliver"])
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--analyze", action="store_true", help="Resume analyze only — no job scraping")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--drain", action="store_true", help="Claim + run all queued agent_runs, then exit")
    ap.add_argument("--serve", action="store_true", help="Drain the run queue in a loop")
    ap.add_argument("--interval", type=int, default=86400)
    args = ap.parse_args()

    worker_id = run_queue.default_worker_id()

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
