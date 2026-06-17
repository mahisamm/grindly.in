"""NexPath agent worker.

One run for one user:
  1. Parse resume -> extract skills (local LLM, heuristic fallback).
  2. Build a plan from the proff answers.
  3. Fetch listings from all connected platforms (in priority order).
  4. Score each vs skills, apply the firewall, and (if auto_apply) submit
     to strong matches up to the daily cap.
  5. Write applications + a daily report into the shared DB.
  6. Send a Slack progress report via the notify adapter.

Platform priority (highest first): linkedin > internshala > naukri > unstop > indeed

Daily cap comes from the user's plan:
  starter = 10/day   pro = 30/day

Usage:
  python worker.py --user <uid> --mode mock|live --once
  python worker.py --loop            # service mode: sweep all active users
"""
from __future__ import annotations
import argparse
import importlib
import json
import sys
import time
import datetime
import os

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

# Source priority order — agent applies across platforms in this sequence.
SOURCE_PRIORITY = ["linkedin", "internshala", "naukri", "unstop", "indeed"]


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
        "max_per_day": cap,  # locked to plan; not user-editable
        "auto_apply": bool(profile.get("auto_apply")),
        "excluded": _jlist(profile.get("excluded_companies")),
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


def cover_letter(name: str, title: str, company: str, skills: list[str]) -> str:
    top = ", ".join(skills[:4]) if skills else "the required skills"
    return (
        f"Hi {company} team,\n\n"
        f"I'm excited to apply for the {title} internship. My background in {top} "
        f"lines up closely with what this role needs, and I pick up new tools fast. "
        f"I'd love to contribute and learn with your team.\n\n"
        f"Thanks for considering me,\n{name or 'A motivated applicant'}"
    )


def _load_module(source: str):
    """Import platform module; returns None if import fails."""
    try:
        return importlib.import_module(source)
    except ImportError as e:
        print(f"[worker] cannot import {source}: {e}")
        return None


def _fetch_live(source: str, mod, domains: list[str], limit: int, uid: str) -> list[dict]:
    """Fetch from a live source; degrade to empty list on error."""
    try:
        return mod.fetch(domains, limit=limit, uid=uid)
    except Exception as e:  # noqa: BLE001
        print(f"[worker] {source} fetch error: {e}")
        return []


def run_for_user(uid: str, mode: str = "mock") -> dict:
    user = db.get_user(uid)
    if not user:
        print(f"[worker] no user {uid}")
        return {"error": "no user"}

    profile = user.get("profile") or {}
    name = user.get("name") or (user.get("email") or "").split("@")[0]
    channel = user.get("slack_channel") or user.get("slack_user_id") or "demo-dm"

    # Plan-locked daily cap
    cap = db.get_plan_cap(uid)
    print(f"[worker] === run for {name} ({uid}) mode={mode} cap={cap}/day ===")

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
        print(f"[worker] extracted {len(skills)} skills: {skills}")

    # 2. plan
    plan = build_plan(profile, skills, cap)
    db.update_skills(uid, skills, plan)
    print(
        f"[worker] plan: domains={plan['domains']} "
        f"threshold={plan['min_match_score']} cap={plan['max_per_day']}"
    )

    # 3. fetch listings from all connected sources
    all_jobs: list[dict] = []
    source_modules: dict = {}

    if mode == "live":
        connected = db.get_connected_platforms(uid)
        active_sources = [s for s in SOURCE_PRIORITY if s in connected]

        if not active_sources:
            print("[worker] no platforms connected — falling back to mock")
            import mockboard
            all_jobs = mockboard.fetch(plan["domains"], limit=cap + 10,
                                       seed=int(time.time()) // 86400)
        else:
            # Spread cap evenly across sources; each fetches a bit extra to give
            # the scorer enough material to reach the daily cap.
            per_source = max(8, (cap + 5) // len(active_sources))
            for src in active_sources:
                mod = _load_module(src)
                if mod is None:
                    continue
                jobs = _fetch_live(src, mod, plan["domains"], per_source + 5, uid)
                print(f"[worker] {src}: fetched {len(jobs)} listings")
                all_jobs += jobs
                source_modules[src] = mod
    else:
        import mockboard
        all_jobs = mockboard.fetch(plan["domains"], limit=cap + 10,
                                   seed=int(time.time()) // 86400)

    print(f"[worker] total fetched: {len(all_jobs)} listings across all sources")

    # 4. score + apply within firewall + daily cap
    already = db.applied_external_ids(uid)
    applied_today = db.todays_applied_count(uid)
    remaining = max(0, cap - applied_today)

    matched = applied = failed = 0
    scored = []
    for job in all_jobs:
        if job["url"] in already:
            continue
        score, reason = matcher.score_job(job, skills, plan["domains"])
        scored.append((score, reason, job))
    scored.sort(key=lambda x: x[0], reverse=True)

    letter_cache: dict[str, str] = {}

    for score, reason, job in scored:
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

        # apply
        if mode == "live" and src in source_modules:
            if src not in letter_cache:
                letter_cache[src] = cover_letter(name, job["title"], job["company"], skills)
            letter = letter_cache[src]
            mod = source_modules[src]
            try:
                status, why = mod.apply(job, letter, uid)
            except Exception as e:  # noqa: BLE001
                status, why = "failed", f"exception: {str(e)[:100]}"
        else:
            status, why = "applied", f"{reason} — auto-applied (demo)"

        if status == "applied":
            applied += 1
            remaining -= 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="applied", reason=why, applied=True,
            )
        elif status == "login_required":
            db.set_integration_status(uid, src, "needs_login")
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{why} — reconnect in dashboard", applied=False,
            )
        elif status == "skipped":
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped", reason=why, applied=False,
            )
        else:
            failed += 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="failed", reason=why, applied=False,
            )

    # close all browser contexts
    if mode == "live":
        for src, mod in source_modules.items():
            try:
                mod.close(uid)
            except Exception:  # noqa: BLE001
                pass

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

    sources_used = (
        ", ".join(source_modules.keys()) if source_modules else "mock board"
    )
    msg = (
        f":robot_face: *NexPath daily report — {today}*\n"
        f":white_check_mark: Applied: *{applied}*  ·  :star: Shortlisted: {matched}  ·  "
        f":x: Failed: {failed}\n"
        f"Sources: {sources_used}\n\n"
        f"{summary}\n\nNext sweep in 24h. Reply *pause* to stop."
    )
    notify.send(channel, msg)
    print(f"[worker] done: applied={applied} matched={matched} failed={failed}")
    return {"applied": applied, "matched": matched, "failed": failed}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user")
    ap.add_argument("--mode", default="mock", choices=["mock", "live"])
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--interval", type=int, default=86400)
    args = ap.parse_args()

    if args.loop:
        print("[worker] service mode: sweeping active users")
        while True:
            for uid in db.active_users():
                try:
                    run_for_user(uid, args.mode)
                except Exception as e:  # noqa: BLE001
                    print(f"[worker] user {uid} failed: {e}")
            time.sleep(args.interval)
    elif args.user:
        run_for_user(args.user, args.mode)
    else:
        print("specify --user <uid> or --loop")


if __name__ == "__main__":
    main()
