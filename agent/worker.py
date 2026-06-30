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

# Source priority order — agent applies across platforms in this sequence.
SOURCE_PRIORITY = ["linkedin", "internshala", "naukri", "unstop", "indeed"]

# --- Beta safety rails -------------------------------------------------------
# Two independent hard caps that sit *under* the user's plan cap. They exist so a
# bug or an over-eager run can never mass-apply (which gets accounts flagged as
# bots). Both are env-overridable so we can loosen them after beta without a
# code change. 0 disables a cap.
#   GRINDLY_CAP_PER_PLATFORM — max applies to one platform in a single run (5)
#   GRINDLY_CAP_PER_RUN      — max applies total in a single run (0 = use plan cap)
SAFETY_CAP_PER_PLATFORM = int(os.environ.get("GRINDLY_CAP_PER_PLATFORM", "15"))
SAFETY_CAP_PER_RUN = int(os.environ.get("GRINDLY_CAP_PER_RUN", "0"))
# Spread applies over time to mimic human pacing — set GRINDLY_SPREAD_APPLIES=1 in prod.
# Each successful apply pauses 5-15 min before the next one.
_SPREAD_APPLIES = os.environ.get("GRINDLY_SPREAD_APPLIES", "0") == "1"
_SPREAD_GAP_SEC = (300, 900)

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
        "min_match_score": profile.get("min_match_score") or 55,
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
    utc = datetime.datetime.utcnow()
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
    """Fetch one platform across all keyword sets; dedup by external_id. Thread-safe — each platform has isolated browser context."""
    seen_eids: set[str] = set()
    jobs: list[dict] = []
    for kw_list in kw_sets:
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
    channel = user.get("slack_channel") or user.get("slack_user_id") or "demo-dm"

    cap = db.get_plan_cap(uid)
    log.info("=== run for %s (%s) mode=%s cap=%d/day ===", name, uid, mode, cap)
    db.add_audit("run_start", user_id=uid, detail=f"mode={mode} cap={cap}")
    # consent trace: auto-apply submits on the user's behalf — record whether
    # they explicitly consented (profile.auto_apply_consent_at). Prototype only
    # warns; production should refuse auto-apply without a consent timestamp.
    if profile.get("auto_apply") and not profile.get("auto_apply_consent_at"):
        log.warning("BLOCKED: auto_apply on without consent timestamp — refusing to submit applications")
        db.add_audit("consent_blocked", user_id=uid, detail="auto_apply blocked: no consent timestamp")
        notify.send(
            channel,
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
        notify.send(
            channel,
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
    if not (8 <= ist_h < 20):
        log.info("outside IST business hours (%dh) — apply delays will be longer", ist_h)

    # 3. fetch listings — live platforms only (no mock/demo path)
    all_jobs: list[dict] = []
    source_modules: dict = {}

    connected = db.get_connected_platforms(uid)
    active_sources = [s for s in SOURCE_PRIORITY if s in connected]

    if not active_sources:
        msg = (
            "no platforms connected. "
            "Connect Internshala in the Integrations tab before running the agent."
        )
        log.warning(msg)
        return {"error": "no_platforms_connected", "message": msg}

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

    _FAIL_RATE_WARN = 0.5   # warn when >50% of attempts on a platform fail

    # Tailored resume cache: title_key -> (pdf_path | None, resume_version_id | None)
    tailor_cache: dict[str, tuple[str | None, str | None]] = {}
    _tailored_dir = os.path.join(_ROOT_DIR, "data", "tailored", uid)

    def _get_resume(title: str, company: str, job_skills: list[str], jd_text: str = "") -> tuple[str | None, str | None]:
        """Build (or reuse) the tailored resume for this role and record an
        immutable ResumeVersion snapshot. Returns (pdf_path, version_id) so the
        application row can point at the exact resume the recruiter received."""
        if not text or mode != "live":
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
    if mode == "live" and approved_apps:
        for app_row in approved_apps:
            if remaining <= 0:
                break
            src = app_row.get("source") or ""
            if src not in source_modules:
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

        if not plan["auto_apply"]:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — awaiting your OK", applied=False,
            )
            continue

        if remaining <= 0:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — daily cap reached", applied=False,
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
        if mode == "live" and src in source_modules:
            mod = source_modules[src]
            # Fetch JD text — enriches cover letter and resume tailoring; refines score
            jd_text = _scrape_jd_if_available(src, mod, job["url"], uid)
            if jd_text:
                score, reason = matcher.score_job(
                    job, skills, plan["domains"], exp_level=plan["exp_level"], jd_text=jd_text
                )
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
                if status == "failed" and any(
                    k in why.lower() for k in ("selector", "not found", "timeout")
                ):
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
        else:
            failed += 1
            per_src_failed[src] = per_src_failed.get(src, 0) + 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="failed", reason=why, applied=False,
                resume_version_id=vid, failure_reason=_classify_failure(why),
            )
            db.add_audit("apply_failed", user_id=uid, target=job.get("url"), detail=why[:120])

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

    # close browser contexts
    if mode == "live":
        for src, mod in source_modules.items():
            try:
                mod.close(uid)
            except Exception:  # noqa: BLE001
                pass

    # urgent: session(s) died mid-run — user must reconnect or the agent stalls
    if needs_login_srcs:
        notify.send(
            channel,
            f":warning: *Action needed* — your session expired on "
            f"{', '.join(sorted(needs_login_srcs))}. Reconnect in the dashboard so "
            f"I can keep applying. (Pending matches are saved.)",
        )
        db.add_audit("notify_urgent", user_id=uid,
                     detail=f"needs_login: {','.join(sorted(needs_login_srcs))}")

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
    msg = (
        f":robot_face: *Grindly daily report — {today}*\n"
        f":white_check_mark: Applied: *{applied}*  ·  :star: Shortlisted: {matched}  ·  "
        f":x: Failed: {failed}\n"
        f"Sources: {sources_used}\n\n"
        f"{summary}\n\nNext sweep in 24h. Pause anytime from the dashboard."
    )
    notify.send(channel, msg)
    log.info("done: applied=%d matched=%d failed=%d", applied, matched, failed)
    return {"applied": applied, "matched": matched, "failed": failed}


def run_job(uid: str, mode: str) -> dict:
    """Queue dispatcher so the web app can ENQUEUE work instead of spawning
    Python itself:
      'analyze'              → resume analysis only
      'connect_<platform>'   → credential login for that platform (hosted)
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
    ap.add_argument("--mode", default="live", choices=["live"])
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
        log.warning("specify --user <uid> [--mode live|mock] [--analyze], --drain, --serve, or --loop")


if __name__ == "__main__":
    main()
