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
import shutil
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
import flags
import readiness
import notify
import latex_resume
import matcher
import questions
import resolver
import resume_parse
import resume_ai
import resume_optimize
import safety
import scam
import company_rep
import drift
import channel_ats
import channel_email
import channel_google_form
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


def _daily_apply_limit(uid: str, plan_cap: int, today: str | None = None) -> int:
    """The free/Plus promise is five slots every day, not a random 3â€“5.

    Higher-volume plans retain the human-paced ceiling above so they do not hit
    a board with the exact same large count every day. The hard plan cap still
    bounds both paths.
    """
    cap = max(1, int(plan_cap))
    if cap <= 5:
        return cap
    return _daily_cap_for_today(uid, cap, today)


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
    # Preserve the caller's priority order (it passes SOURCE_PRIORITY filtered to
    # the connected platforms) and ALWAYS include the top-priority one. A day's
    # dice must never strand the user on only a weaker/less-reliable board — that
    # is exactly how a run finds nothing while the mature platform sits untouched
    # (e.g. an "unstop-only" day when internshala is the one that actually returns
    # listings). A human checks their main job site every day anyway; the rotation
    # variety comes from the *additional* platform(s) chosen below.
    primary = available[0]
    rest = list(available[1:])
    # Draw the count first (same RNG order as before this guarantee was added, so
    # the 1-vs-2 platform-day distribution is unchanged), then shuffle the rest.
    n = min(len(available), rng.choice([1, 2, 2]))
    rng.shuffle(rest)
    return [primary] + rest[: max(0, n - 1)]


def _requires_approval(src: str, auto_apply: bool) -> bool:
    """True when discovery must stop before final *board* submission.

    Delegates to `safety.requires_manual_final_submit`, which answers by the
    board's tier: a Tier B board the user gave credentials to may be submitted
    when the fleet is live and Tier B is switched on; Tier C and every
    unrecognised source still fail closed.

    `auto_apply` is deliberately unused.  The profile toggle is a separate
    question — "may the agent act for me at all" — and the caller applies it
    one step earlier, so a user who switched it off is never overridden by a
    policy that happens to say yes.

    Only governs the board channel.  Applications routed to an employer's own
    intake go through `safety.destination_policy()` instead — see
    `_resolve_destination` below and agent/resolver.py for why those are a
    different risk class entirely.
    """
    del auto_apply
    return safety.requires_manual_final_submit(src)[0]


# How many extra page loads one run may spend resolving where applications
# really go. Resolution is nearly free when the JD is already in hand (the
# re-scoring step fetches the top few); this budget caps the case where it is
# not, so a discovery sweep cannot turn into a crawl.
RESOLVE_FETCH_BUDGET = int(os.environ.get("GRINDLY_RESOLVE_FETCH_BUDGET", "12"))

# Channels that deliver to an employer directly. Keyed by resolver channel so a
# new channel is one entry here plus one module, with no branching in the loop.
_CHANNEL_MODULES = {
    resolver.CHANNEL_GOOGLE_FORM: channel_google_form,
    resolver.CHANNEL_EMAIL: channel_email,
    resolver.CHANNEL_ATS: channel_ats,
}

# Tier A says "safe to submit unattended". It does NOT say "we have something
# that can submit it, switched on, right now". Those are three separate facts and
# conflating any two of them has already caused one real bug: a dict miss in
# _CHANNEL_MODULES used to fall straight through to the BOARD adapter, so an
# ATS-routed listing found on LinkedIn would be handed to linkedin.apply(). That
# is the exact thing this whole design exists to prevent, and it survived only
# because Safe Apply Mode caught it one layer further down.
#
# So deliverability is an explicit question with an explicit answer.
def channel_deliverable(dest: dict | None) -> bool:
    """Do we have a sender for this channel, and is that sender switched on?

    The second half matters as much as the first. A sender that exists but is
    disabled — `channel_email` while gmail.send is still waiting on Google's
    restricted-scope review, `channel_ats` with its kill switch off — cannot
    deliver today, and calling it deliverable spends one of the user's daily
    quota slots on a dispatch that can only come back as needs_review.
    """
    if not dest:
        return False
    channel = dest.get("channel")
    if channel == resolver.CHANNEL_PLATFORM:
        return True          # board adapters exist; policy decides if they may run
    # Fleet kill switch for every Tier A server executor at once. Checked here —
    # the same single gate that already answers "can this dispatch today?" — so
    # a flagged-off destination is banked as matched, not spent as a failed send.
    if not flags.direct_submit_enabled():
        return False
    mod = _CHANNEL_MODULES.get(channel)
    if mod is None or not dest.get("target"):
        return False
    # Channels without a kill switch (Google Form) are always on.
    is_on = getattr(mod, "enabled", None)
    return bool(is_on()) if callable(is_on) else True


_UNDELIVERABLE_REASON = {
    resolver.CHANNEL_ATS: (
        "found the company's own application portal, but portal auto-apply is "
        "switched off right now — open it and send it in one step"
    ),
    resolver.CHANNEL_EMAIL: (
        "found the company's hiring inbox, but Grindly can't send mail from your "
        "account yet — open it and send it yourself"
    ),
}


def _resolve_destination(job: dict, jd_text: str, *, allow_fetch: bool) -> tuple[dict, int]:
    """Where should this application actually be delivered?

    Returns (destination, page_loads) — the caller charges `page_loads` against
    the run's fetch budget, so the budget tracks real traffic rather than how
    many listings happened to route somewhere.

    Never raises and never blocks a run: any failure falls back to the board
    channel, which is exactly the behaviour that existed before routing.
    """
    loads = 0
    fetch = None
    # Only spend a page load when the JD says the application lives elsewhere.
    # Fetching every listing's outbound links to find out would be a crawl.
    if allow_fetch and resolver.looks_like_external_apply(jd_text):
        def fetch(url: str) -> str:  # noqa: E306 — small local, deliberate
            nonlocal loads
            loads += 1
            return _fetch_public_html(url)
    try:
        return resolver.resolve(job, jd_text, fetch=fetch), loads
    except Exception as e:  # noqa: BLE001
        log.warning("destination resolution failed for %s: %s", job.get("url"), e)
        fallback = resolver.platform_destination(
            job, resolver.platform_tier(job.get("source") or "")
        )
        return fallback, loads


def _fetch_public_html(url: str, timeout: int = 20) -> str:
    """Plain GET of a public page — a company careers page linked from a JD.

    Deliberately not the Playwright stack: this is reading a public page to find
    an application link, not operating a logged-in session, and it should cost a
    request rather than a browser.

    The URL comes from attacker-controlled text (anyone who can post a listing can
    put a link in it), so resolver.is_fetchable() gates both the initial URL and
    the final URL after redirects — a public host can 302 to an internal one, and
    checking only the first would be checking the wrong thing.
    """
    import urllib.request

    if not resolver.is_fetchable(url):
        log.debug("refusing to fetch non-public URL from a listing: %s", url)
        return ""

    req = urllib.request.Request(url, headers={
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
        ),
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            if not resolver.is_fetchable(r.geturl()):
                log.debug("refusing redirect to a non-public URL: %s", r.geturl())
                return ""
            ctype = (r.headers.get("Content-Type") or "").lower()
            if "html" not in ctype and "text" not in ctype:
                return ""
            return r.read(600_000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        log.debug("careers-page fetch failed for %s: %s", url, e)
        return ""


def _dispatch_apply(
    dest: dict, job: dict, letter: str, uid: str, *,
    profile: dict, resume_path: str | None, record: dict,
    skills: list[str], source_modules: dict,
) -> tuple[str, str]:
    """Submit through whichever channel the resolver picked.

    Employer channels (Google Form, email) take a `target` — the resolved form
    URL or mailbox — because the listing URL is not where the application goes.
    Board adapters keep their existing signature untouched.

    A destination we cannot deliver NEVER falls back to the board. Routing a
    listing away from LinkedIn and then submitting it on LinkedIn anyway would
    invert the entire point of the resolver, and it is the kind of mistake a bare
    `dict.get() or fallthrough` makes silently.
    """
    channel = dest.get("channel")
    mod = _CHANNEL_MODULES.get(channel)
    if mod is not None:
        # Idempotency. A queue message can be redelivered — a crash after the
        # POST but before the status write, a retry of an ambiguous timeout, a
        # run reclaimed as stale — and the second attempt would send a DUPLICATE
        # application to a real employer under the user's name. That cannot be
        # undone and reads to a recruiter as spam. The ledger claim is the lock.
        key = db.submission_key(uid, job.get("url") or "", channel, dest.get("target") or "")
        if not db.claim_submission(key, uid):
            return "skipped", "already submitted through this channel — not sending it twice"
        try:
            status, why = mod.apply(
                job, letter, uid, profile=profile, resume_path=resume_path,
                record=record, target=dest.get("target") or "", skills=skills,
            )
        except Exception as e:
            # Playwright's synchronous API refuses to start in the worker's
            # asyncio-owning thread. ATS submission is still synchronous by
            # design, so execute it on one fresh thread rather than turning a
            # valid employer application into a guaranteed failure. This is
            # safe before the browser starts; after any submit ambiguity the
            # existing exception path below retains the idempotency claim.
            if "Sync API inside the asyncio loop" in str(e):
                try:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                        status, why = executor.submit(
                            mod.apply,
                            job, letter, uid,
                            profile=profile, resume_path=resume_path,
                            record=record, target=dest.get("target") or "", skills=skills,
                        ).result()
                except Exception as retry_e:
                    db.record_submission(
                        key, "exception",
                        f"sender raised after isolated retry: {str(retry_e)[:160]}",
                    )
                    raise
            else:
                # An exception proves nothing about whether the POST landed, so
                # the claim STAYS. Re-raising with the claim held is the safe
                # direction: a missed application is recoverable, a duplicate
                # one is not. The receipt carries the real error — six rows of
                # bare "sender raised" once cost a day of diagnosis.
                db.record_submission(key, "exception", f"sender raised: {str(e)[:160]}")
                raise
        # Release only on a definite non-send, so a real retry stays possible.
        # A needs_review AFTER the irreversible action keeps its claim: that
        # submit landed and only its confirmation was unreadable
        # (safety.classify_submit). A needs_review BEFORE it — sender switched
        # off, no resume file, form unreadable — provably sent nothing, and
        # keeping the claim froze that listing on this channel forever. The
        # sender tells us which it was via record["submit_attempted"], set
        # immediately before its point of no return.
        if status in ("failed", "skipped", "login_required") or (
            status == "needs_review" and not record.get("submit_attempted")
        ):
            db.release_submission(key)
        else:
            db.record_submission(key, status, why)
        return status, why

    if channel != resolver.CHANNEL_PLATFORM:
        return "needs_review", _UNDELIVERABLE_REASON.get(
            channel, f"no sender for a {channel} destination yet — open it yourself"
        )

    src = job.get("source") or ""
    platform_mod = source_modules.get(src)
    if platform_mod is None:
        return "skipped", f"{src} unavailable this run"

    # The board channel gets the SAME idempotency ledger as the employer
    # channels. A hosted Tier B submit is exactly as unrecallable as an ATS
    # POST, and it had no claim at all — so a redelivered queue message, or a
    # browser task racing the hosted sender for the same application, could
    # file a duplicate under the user's own account name.
    key = db.submission_key(uid, job.get("url") or "", resolver.CHANNEL_PLATFORM, src)
    if not db.claim_submission(key, uid):
        return "skipped", "already submitted through this channel — not sending it twice"
    try:
        status, why = platform_mod.apply(
            job, letter, uid, profile=profile, resume_path=resume_path, record=record,
        )
        # Retry ONLY on clearly pre-submit failures (missing selector / element). A
        # "timeout" can fire AFTER the submit click went through, so retrying it
        # would file a SECOND real application.
        if status == "failed" and any(
            k in why.lower() for k in ("selector", "not found", "element")
        ) and "timeout" not in why.lower():
            time.sleep(random.randint(15, 40))
            status, why = platform_mod.apply(
                job, letter, uid, profile=profile, resume_path=resume_path, record=record,
            )
    except Exception:
        # Same rule as the employer channels: an exception proves nothing about
        # whether the click landed, so the claim STAYS.
        db.record_submission(key, "exception", "board sender raised")
        raise
    if status in ("failed", "skipped", "login_required") or (
        status == "needs_review" and not record.get("submit_attempted")
    ):
        db.release_submission(key)
    else:
        db.record_submission(key, status, why)
    return status, why


def _queue_browser_task(uid: str, dest: dict, job_url: str, ready: bool,
                        application_id: str = "") -> bool:
    """Queue this application for the user's OWN browser, if it can run there.

    One producer-shape for both of its call sites: the bank-it branch (our
    servers may not send this) and the refused-at-the-door fallback (our servers
    TRIED and the page demanded a human). The second is what makes web-found
    employer sites actually reachable: the VPS is a datacenter IP with no
    session and no history, so ATS portals routinely answer it with a
    human-check — which the user's signed-in, lived-in browser never sees.
    Without the fallback those applications just looped: re-scored next run,
    refused again, forever server-side-only on the one path that cannot pass.
    """
    channel = dest.get("channel")
    browser_url = (
        dest.get("target")
        if channel in (resolver.CHANNEL_ATS, resolver.CHANNEL_GOOGLE_FORM)
        else job_url
    )
    browserable = (
        channel == resolver.CHANNEL_PLATFORM
        or channel in (resolver.CHANNEL_ATS, resolver.CHANNEL_GOOGLE_FORM)
    )
    if not (
        flags.browser_executor_enabled()
        and browserable
        and ready
        and isinstance(browser_url, str)
        and browser_url.startswith("https://")
    ):
        return False
    app_id = application_id or _last_application_id(uid, job_url)
    return bool(app_id and db.enqueue_browser_task(uid, app_id, browser_url))


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

# Platforms we can DISCOVER on with no login — every fetcher scrapes public search
# / a guest API anonymously, so discovery is decoupled from "connecting" (a login
# flow only apply and the Apply-Kit answer-draft use). internshala first so the
# most reliable, internship-focused board is always in the daily rotation
# (_platforms_for_today always includes index 0).
DISCOVERY_PLATFORMS = ["internshala", "naukri", "linkedin", "unstop", "indeed"]

# Sources that are not job boards. Both find internships on employers' OWN
# pages — the only listings the agent can submit unattended, because the
# candidate holds no account there (resolver.TIER_A). Neither enters the daily
# board rotation: the rotation exists to look human to sites that watch for
# bots, and an API is not one of those sites.
#
#   websource  searches the open web. Reaches careers pages and Google Forms
#              that no ATS API lists, but only while a search engine answers —
#              and every general engine blocks this server's datacenter IP.
#   atsboards  asks Greenhouse/Lever/Ashby directly. Sees only the boards it is
#              pointed at, and needs no engine, key or quota to see them.
#
# Both, because their blind spots are opposite ones.
ALWAYS_ON_SOURCES = ["websource", "atsboards"]

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


def build_plan(profile: dict, skills: list[str], cap: int, user: dict | None = None) -> dict:
    # `user` carries the name/email half of the readiness check. It is optional
    # so older callers (and tests that only care about matching) keep working;
    # without it readiness fails closed on `contact`, which is the safe default
    # — a run that cannot prove readiness prepares instead of sending.
    ready, not_ready = readiness.check({**(user or {}), "profile": profile})
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
        "ready": ready,
        "not_ready": not_ready,
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


# How many role angles a single run may search. The old value was 4, and it was
# not a pacing decision so much as an accident: the list was built from
# `domains[:2]` plus up to seven skill-derived variants and then truncated, so
# the third domain a user typed and every variant after the fourth were dropped
# without a word. Measured on a real resume, a candidate whose profile said
# "ai intern" and whose skills were YOLOv8, Tesseract, OpenCV, PyTorch and the
# OpenAI API was searched for as: web development, full stack, frontend
# developer, python developer. Not one AI query, ever.
MAX_SEARCH_ANGLES = int(os.environ.get("GRINDLY_SEARCH_ANGLES", "12"))


def _expand_search_keywords(domains: list[str], skills: list[str]) -> list[list[str]]:
    """The role titles this run will search for, one per set.

    Delegates to rolequeries, which asks a model to map skills onto the titles
    employers actually advertise and falls back to a deterministic ladder when
    no model answers. Kept returning list-of-lists because every board adapter
    takes a keyword LIST — one title per set is what "search for this role"
    means to them.
    """
    try:
        import rolequeries

        roles = rolequeries.roles_for(skills, domains)
    except Exception as e:  # noqa: BLE001 — discovery must never fail on this
        log.warning("role query generation failed (%s); using domains as typed", e)
        roles = [d for d in (domains or []) if d]

    seen: set[str] = set()
    result: list[list[str]] = []
    for role in roles:
        key = (role or "").strip().lower()
        if key and key not in seen:
            seen.add(key)
            result.append([key])
    if not result:
        result = [["software engineer"]]
    return result[:MAX_SEARCH_ANGLES]


def _scrape_jd_if_available(src: str, mod, url: str, uid: str) -> str:
    """Call mod.scrape_jd() if it exists; return '' otherwise."""
    fn = getattr(mod, "scrape_jd", None)
    if fn is None:
        return ""
    try:
        return fn(url, uid) or ""
    except Exception as e:  # noqa: BLE001
        # Playwright's synchronous API refuses to start on a thread that happens
        # to own a running asyncio loop. Some LLM/provider clients leave exactly
        # that state behind on the main worker thread. Retry the read-only scrape
        # on a fresh thread, and close its browser on that same thread because
        # Playwright objects are thread-bound.
        if "Sync API inside the asyncio loop" in str(e):
            def scrape_in_isolated_thread() -> str:
                try:
                    return fn(url, uid) or ""
                finally:
                    close = getattr(mod, "close", None)
                    if callable(close):
                        close(uid)

            try:
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
                    return executor.submit(scrape_in_isolated_thread).result()
            except Exception as retry_error:  # noqa: BLE001
                log.warning("%s isolated scrape_jd retry error: %s", src, retry_error)
                return ""
        log.warning("%s scrape_jd error: %s", src, e)
        return ""


def _prepare_answers_if_available(
    src: str, mod, url: str, uid: str, profile: dict, skills: list[str], job: dict,
) -> str | None:
    """Draft a listing's screening-question answers BEFORE the user ever opens the
    form, so the Apply Kit is ready rather than a promise. Read-only: calls
    mod.harvest_questions() (if the platform has one — read the form, never fill
    or submit) then the platform-agnostic questions.answer_fields(), same as every
    adapter's live apply() flow already does. Mirrors _scrape_jd_if_available's
    shape and safety boundary exactly.

    Some platforms only reveal their questions after an initial page interaction
    that a given adapter may not yet expose read-only (or hides them behind a
    later step entirely) — for those this returns None and the kit ships without
    drafted answers for that listing. Never a fabricated answer.
    """
    fn = getattr(mod, "harvest_questions", None)
    if fn is None or not url:
        return None
    try:
        fields = fn(url, uid)
        if not fields:
            return None
        answers = questions.answer_fields(
            fields,
            profile=profile,
            resume_text=profile.get("resume_text") or "",
            skills=skills,
            job=job,
            name=profile.get("name") or "",
            email=profile.get("email") or "",
        )
        return questions.to_record(answers)
    except Exception as e:  # noqa: BLE001
        log.warning("%s harvest_questions error: %s", src, e)
        return None


def _ist_hour() -> int:
    """Current hour in IST (UTC+5:30) — no external dependency."""
    utc = datetime.datetime.now(datetime.timezone.utc)
    ist = utc + datetime.timedelta(hours=5, minutes=30)
    return ist.hour


def _search_engines_answering() -> list[str]:
    """Which upstream engines actually replied this process. [] when unknown."""
    try:
        import websearch

        return websearch.engines_answering()
    except Exception:  # noqa: BLE001
        return []


def _load_module(source: str):
    """Import platform module; returns None if import fails."""
    try:
        return importlib.import_module(source)
    except ImportError as e:
        log.error("cannot import %s: %s", source, e)
        return None


def _fetch_live(
    source: str, mod, domains: list[str], limit: int, uid: str,
    errors: dict[str, str] | None = None,
) -> list[dict]:
    try:
        return mod.fetch(domains, limit=limit, uid=uid)
    except Exception as e:  # noqa: BLE001
        log.error("%s fetch error: %s", source, e)
        # Carried into the source_zero_yield audit row: the log line at this
        # timestamp was the ONLY place the reason existed, and container logs
        # do not survive a redeploy.
        if errors is not None:
            errors[source] = str(e)[:180]
        return []


def _fetch_source_all_kw(
    src: str, mod, kw_sets: list[list[str]], per_kw: int, uid: str,
    errors: dict[str, str] | None = None,
) -> tuple[str, list[dict]]:
    """Fetch one platform across all keyword sets; dedup by external_id. Thread-safe — each platform has isolated browser context.

    Firing every search back-to-back the instant login completes is itself a
    bot tell independent of apply pacing — a human tries one search term,
    looks at results, then tries the next. A small gap between searches
    matches that rhythm without materially slowing the run."""
    seen_eids: set[str] = set()
    jobs: list[dict] = []
    # The always-on sources take the whole keyword list in one call and pace
    # themselves. Splitting their work per keyword set made atsboards re-poll
    # every board once per set — 232 requests for 58 boards, measured — while
    # the keywords only ever affected which results it ranked first.
    if src in ALWAYS_ON_SOURCES:
        flat = [kw for kw_list in kw_sets for kw in kw_list]
        try:
            for j in _fetch_live(src, mod, flat, max(per_kw * len(kw_sets), per_kw), uid,
                                 errors=errors):
                eid = j.get("external_id") or j.get("url", "")
                if eid and eid not in seen_eids:
                    jobs.append(j)
                    seen_eids.add(eid)
        finally:
            try:
                mod.close(uid)
            except Exception:  # noqa: BLE001
                log.exception("failed to close %s in fetch thread for %s", src, uid)
        log.info("%s: fetched %d unique listings (%d keyword(s), one pass)",
                 src, len(jobs), len(flat))
        return src, jobs
    try:
        for i, kw_list in enumerate(kw_sets):
            if i > 0:
                time.sleep(random.uniform(*_BASE_PACE_SEC))
            for j in _fetch_live(src, mod, kw_list, per_kw + 5, uid, errors=errors):
                eid = j.get("external_id") or j.get("url", "")
                if eid and eid not in seen_eids:
                    jobs.append(j)
                    seen_eids.add(eid)
    finally:
        # Close this platform's browser context on the SAME thread that opened it.
        # The context is created lazily inside this executor thread (mod.fetch ->
        # _context), and Playwright's sync objects are bound to their creating
        # thread — so the later main-thread _close_all_adapter_contexts sweep could
        # not actually close it. The Chromium lingered holding the persistent-profile
        # lock, so the NEXT run failed to launch ("profile already in use by another
        # instance of Chromium") and then cascaded into "Playwright Sync API inside
        # the asyncio loop", fetching 0 listings. Closing in-thread releases the lock
        # every run. The apply phase re-opens a fresh context on the main thread when
        # needed; the login session lives in the on-disk profile, so nothing is lost.
        try:
            mod.close(uid)
        except Exception:  # noqa: BLE001
            log.exception("failed to close %s context in fetch thread for %s", src, uid)
    log.info("%s: fetched %d unique listings (%d keyword sets)", src, len(jobs), len(kw_sets))
    return src, jobs


def _last_application_id(uid: str, url: str | None) -> str:
    """Id of the row just written for this listing, for its timeline entry.

    add_application does not hand one back, and changing its signature would
    touch every call site; this reads the row back instead. Returns "" when it
    cannot be found — add_application_event tolerates that, because a missing
    timeline entry must never be the thing that fails a real submission."""
    if not url:
        return ""
    try:
        with db.conn() as c:
            row = c.execute(
                "SELECT id FROM applications WHERE user_id=? AND url=? "
                "ORDER BY created_at DESC LIMIT 1",
                (uid, url),
            ).fetchone()
        return row["id"] if row else ""
    except Exception:  # noqa: BLE001
        return ""


def _user_facing_failure(e: Exception, src: str) -> str:
    """Turn a crash into something a job-seeker can actually read.

    The raw text used to go straight onto the application row, so a user's
    activity log showed things like "exception: It looks like you are using
    Playwright Sync API inside the asyncio loop". That tells them nothing they
    can act on, looks like the product is broken in their hands, and leaks our
    internals into their history. The real error still goes to the log, where
    the person who can fix it will actually see it.
    """
    log.exception("apply failed on %s", src)
    text = str(e).lower()
    if "timeout" in text or "timed out" in text:
        return f"{src} took too long to respond — the agent will try again."
    if "net::" in text or "connection" in text or "dns" in text:
        return f"Couldn't reach {src} just now — the agent will try again."
    if "closed" in text or "detached" in text:
        return f"The {src} page closed before the agent finished — it will retry."
    return f"Something went wrong on {src} — the agent stopped and will retry."


def _tailor_key(title: str, company: str = "") -> str:
    """Cache key for a tailored resume — unique per (title, company).

    Includes the company because two listings can share a title ("Web Development
    Internship" is on Internshala a hundred times) while asking for very different
    things, and reusing one company's tailored resume for another is exactly the
    kind of silent wrongness nobody would catch.

    The readable part is truncated so filenames and logs stay legible, which is
    why it cannot BE the key on its own. "Software Development Engineer Intern -
    Backend" and "... - Frontend" share their first 30 characters, and collapsing
    punctuation makes "C++ Developer" and "C Developer" the same string. Either
    collision hands one role the resume that was tailored for another — within a
    single run, since the cache is keyed on exactly this. The digest is taken over
    the untruncated pair, separated by a character normalization cannot produce,
    so it is the part that actually tells the roles apart.
    """
    t, c = (title or "").strip().lower(), (company or "").strip().lower()
    digest = hashlib.sha1(f"{t}\x1f{c}".encode()).hexdigest()[:10]
    slug = re.sub(r"[^a-z0-9]+", "_", f"{t[:30]}_{c[:20]}").strip("_")
    return f"{slug}_{digest}" if slug else digest


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
    """Send every currently due-and-unnotified match in ONE message. Never
    contacts a job platform.

    Used to send exactly one match per call and rely on the next sweep tick (10
    min later) to pick up the rest — so a user with several due at once (their
    first batch, or one who'd skipped a day) got a separate notification every
    ten minutes instead of one clear "N matches ready" message. That trickle
    read as the agent barely working; batching what's due right now fixes it
    without changing anything about the daily release pacing itself.
    """
    apps = db.due_unnotified_matches(uid)
    if not apps:
        return {"delivered": 0}

    if len(apps) == 1:
        app = apps[0]
        source = app.get("source") or "job platform"
        text = (
            f":link: *Your next match is ready*\n"
            f"*{app['job_title']}* at *{app['company']}* ({app['match_score']} match)\n"
            f"Open: {app['url']}\n\n"
            f"Complete the final Apply/Submit step yourself on {source}. Then return to "
            "Grindly and mark it submitted so your daily limit and outcome tracking stay accurate."
        )
        subject = "Grindly: your next application link is ready"
    else:
        lines = "\n".join(
            f"• *{a['job_title']}* at *{a['company']}* ({a['match_score']} match) — {a['url']}"
            for a in apps
        )
        text = (
            f":link: *{len(apps)} matches are ready*\n{lines}\n\n"
            "Open each one and complete the final Apply/Submit step yourself, then return "
            "to Grindly and mark it submitted so your daily limit and outcome tracking stay accurate."
        )
        subject = f"Grindly: {len(apps)} application links are ready"

    sent = notify.to_user(user, subject, text)
    if not sent and notify.any_channel_configured():
        # A channel is configured but the send failed (transient) — leave the
        # matches unnotified so the next sweep retries delivery.
        return {"delivered": 0, "undelivered": len(apps)}
    # Either it sent, OR no channel is configured at all. In the no-channel case
    # the matches are already visible in-app (dashboard + bell), so mark them
    # notified regardless — otherwise the sweep re-enqueues a delivery run every
    # 10 minutes per user forever, chasing a channel that does not exist.
    delivered_ids = [a["id"] for a in apps if db.mark_match_notified(a["id"])]
    db.add_audit(
        "application_link_delivered", user_id=uid, target=None,
        detail=f"{len(delivered_ids)} match(es): " + ", ".join(delivered_ids),
    )
    return {"delivered": len(delivered_ids), "application_ids": delivered_ids}


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
    # Prefill blank form-fill fields off the resume — phone, GPA, degree, college,
    # graduation year, profile links — so setup asks the user to CONFIRM what
    # their own resume already says instead of typing it again. Only runs here
    # (resume actually (re)analyzed), never overwrites a value the user set, and
    # never aborts analysis on failure.
    try:
        contact = resume_ai.extract_contact(text, this_year=datetime.date.today().year)
        filled = db.update_contact(
            uid,
            phone=contact.get("phone"),
            gpa=contact.get("gpa"),
            degree=contact.get("degree"),
            college=contact.get("college"),
            grad_year=contact.get("grad_year"),
            linkedin_url=contact.get("linkedin_url"),
            github_url=contact.get("github_url"),
        )
        if filled:
            log.info("prefilled from resume: %s", ", ".join(filled.keys()))
    except Exception as e:  # noqa: BLE001
        log.warning("contact prefill failed for %s: %s", uid, e)
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
            else:
                # The file is there and both extractors got nothing out of it —
                # a scanned/image-only PDF, or a format neither can read. That
                # is a parse failure the user has to be told about, because from
                # their side the upload succeeded: without this flag the
                # dashboard shows a happily-uploaded resume that silently powers
                # no matching, no skills and no score.
                #
                # Distinct from "no file at all" below, which is not a failure —
                # it is simply someone who has not uploaded yet.
                db.set_resume_parse_failed(uid, True)
                log.warning("resume at %s produced no text for %s", path, uid)
                return {"error": "resume_unreadable"}

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

    # "approved" is a submit-only run: drain the approved queue, no scraping and
    # no scoring.  The dashboard's approve endpoint enqueues it whenever the
    # agent is the one that will send, so a tap on Approve results in a submit
    # rather than waiting for the next full run or the daily sweep.
    submit_only = mode == "approved"
    live = mode in ("live", "approved")

    user_plan = db.get_user_plan(uid)
    plan_cap = db.get_plan_cap(uid)
    # Free beta: free is a DAILY plan (5/day), same shape as paid — human-paced
    # and counted per day. No lifetime trial, so it resets each day like Plus/Pro.
    cap = _daily_apply_limit(uid, plan_cap)
    quota_used = db.todays_applied_count(uid)
    quota_kind = "today"
    log.info("=== run for %s (%s) mode=%s cap=%d used=%d (%s) ===", name, uid, mode, cap, quota_used, quota_kind)
    # One line per run answering "why did nothing send?" before anyone has to ask.
    log.info("flags: %s | auto_apply_mode=%s", flags.snapshot(), safety.auto_apply_mode())
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
    plan = build_plan(profile, skills, cap, user)
    if not plan["ready"]:
        # Not fatal: discovery, scoring and preparation all still run, so the
        # queue is warm the moment setup is finished. Only SENDING is held.
        log.info("autopilot held — setup incomplete: %s", ", ".join(plan["not_ready"]))
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
    # connected_platforms is only used by the (manual-hold) apply phase and the
    # account-wide challenge pause. Discovery does NOT require it — every fetcher
    # scrapes public listings / a guest API with no login, so the agent searches
    # for a user who has connected nothing. See DISCOVERY_PLATFORMS.

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
        _platforms_for_today(
            uid, [s for s in DISCOVERY_PLATFORMS if flags.source_enabled(s)]
        )
        if discover and not flags.no_touch_only() else []
    )
    if discover:
        # Appended after the rotation, never subject to it.
        active_sources = active_sources + [
            s for s in ALWAYS_ON_SOURCES if flags.source_enabled(s)
        ]
    if active_sources:
        log.info("platform rotation today: %s (connected: %s)", active_sources, connected_platforms)

    if discover:
        kw_sets = _expand_search_keywords(plan["domains"], skills)
        per_kw = max(8, (cap + 5) // max(1, len(active_sources) * len(kw_sets)))

        # Load modules serially (importlib side-effects must stay single-threaded)
        loaded: dict[str, object] = {}
        # Why a source produced nothing, keyed by source — lands in the
        # source_zero_yield audit row so the answer survives a redeploy.
        fetch_errors: dict[str, str] = {}
        for src in active_sources:
            mod = _load_module(src)
            if mod is not None:
                loaded[src] = mod
            else:
                fetch_errors[src] = "adapter import failed — see worker log"

        # Board platforms fetch in parallel — each has an isolated browser
        # context per uid. The always-on sources run as ONE ordered task beside
        # them, because their order is load-bearing: websource hands every ATS
        # address it finds to atsboards, which then polls those companies in
        # this same run instead of tomorrow's. Run concurrently, atsboards would
        # start before there was anything to hand it.
        def run_always_on() -> list[tuple[str, list[dict]]]:
            out = []
            for name in ALWAYS_ON_SOURCES:
                mod_on = loaded.get(name)
                if mod_on is not None:
                    out.append(_fetch_source_all_kw(
                        name, mod_on, kw_sets, per_kw, uid, fetch_errors))
            return out

        board_srcs = {s: m for s, m in loaded.items() if s not in ALWAYS_ON_SOURCES}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(loaded))) as ex:
            futs = {
                ex.submit(_fetch_source_all_kw, src, mod, kw_sets, per_kw, uid, fetch_errors): src
                for src, mod in board_srcs.items()
            }
            if any(s in loaded for s in ALWAYS_ON_SOURCES):
                futs[ex.submit(run_always_on)] = "|".join(ALWAYS_ON_SOURCES)
            for fut in concurrent.futures.as_completed(futs):
                src_done = futs[fut]
                try:
                    result = fut.result()
                    for name, src_jobs in (result if isinstance(result, list) else [result]):
                        all_jobs.extend(src_jobs)
                        source_modules[name] = loaded[name]
                except Exception as e:  # noqa: BLE001
                    log.error("%s parallel fetch error: %s", src_done, e)
                    for name in src_done.split("|"):
                        fetch_errors[name] = str(e)[:180]

        log.info("total fetched: %d listings across all sources", len(all_jobs))

        # Per-source yield. The total-zero alarm below only fires when EVERY
        # source is dead; one adapter quietly returning nothing (markup drift,
        # a block, an expired selector) hides inside a healthy total and starves
        # that source's supply for weeks. Record each so /admin can see which
        # one stopped, and say so in the log even when the run looks fine.
        per_source: dict[str, int] = {}
        for j in all_jobs:
            src_name = j.get("source") or "?"
            per_source[src_name] = per_source.get(src_name, 0) + 1
        for src_name in active_sources:
            got = per_source.get(src_name, 0)
            if got == 0:
                why_zero = fetch_errors.get(src_name)
                if why_zero is None:
                    mod_zero = loaded.get(src_name)
                    is_on = getattr(mod_zero, "enabled", None) if mod_zero else None
                    if callable(is_on) and not is_on():
                        why_zero = "source disabled (flag or provider not configured)"
                    else:
                        why_zero = "fetched OK — nothing matched the filters"
                log.warning("source %s yielded 0 listings this run: %s", src_name, why_zero)
                db.add_audit("source_zero_yield", user_id=uid, target=src_name, detail=why_zero)
        log.info("per-source yield: %s", per_source or "{}")

        # Coverage, recorded rather than assumed. Nothing in the system could
        # have told you the agent never searched a user's stated domain — the
        # run reported listings found and looked healthy, and the gap was
        # invisible for as long as it existed. These four numbers make a
        # regression in BREADTH visible the same way source_zero_yield makes a
        # dead adapter visible.
        try:
            angles = [kw[0] for kw in kw_sets if kw]
            trusted = sum(1 for j in all_jobs if j.get("host_class") in ("ats", "employer")
                          or j.get("source") == "atsboards")
            employers = {(j.get("company") or "").strip().lower()
                         for j in all_jobs if (j.get("company") or "").strip()}
            coverage = {
                "angles": angles,
                "sources": active_sources,
                "listings": len(all_jobs),
                "trusted": trusted,
                "employers": len(employers),
                "engines": _search_engines_answering(),
            }
            log.info(
                "discovery coverage: %d angle(s) %s | %d listing(s), %d on an "
                "employer page, %d distinct employer(s) | engines: %s",
                len(angles), angles, len(all_jobs), trusted, len(employers),
                ", ".join(coverage["engines"]) or "none",
            )
            db.add_audit("discovery_coverage", user_id=uid,
                         detail=json.dumps(coverage)[:900])
        except Exception as e:  # noqa: BLE001 — telemetry never fails a run
            log.warning("could not record discovery coverage: %s", e)

        # Core-value alarm: discovery yielding >0 is the whole product. If every
        # rotated board fetched nothing, the scrapers are almost certainly broken
        # (anti-bot / markup drift) — the exact "ran done but banked 0 matches"
        # failure we hit before. The drift monitor below only fires on APPLY
        # attempts, which never happen in Safe Apply Mode, so a total-zero discovery
        # would otherwise pass completely silently. Page it here instead.
        if active_sources and not all_jobs:
            log.error(
                "DISCOVERY YIELD 0: %s returned no listings this run — scrapers likely broken",
                active_sources,
            )
            db.add_audit("discovery_zero_yield", user_id=uid, target=",".join(active_sources))
            notify.send(
                _OPS_CHANNEL,
                f":rotating_light: Discovery returned *0 listings* across "
                f"{', '.join(active_sources)} for user `{uid}` — every rotated board "
                f"fetched nothing. Anti-bot block or selector drift; investigate before "
                f"matches dry up.",
            )

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
    # Seeded from the DB, not empty. Rebuilt empty this set only deduped WITHIN
    # one invocation, so the same role cross-posted to a second board was applied
    # to again on the next run — and, under spread mode, on the next segment of
    # the same run, since a requeue re-enters here. Two applications to one
    # employer for one role, under the candidate's real name.
    applied_keys: set[tuple[str, str]] = db.committed_role_keys(uid)
    per_src_applied: dict[str, int] = {}   # per-platform applies this run (bot-pace guard)
    per_src_failed:  dict[str, int] = {}   # per-platform failures this run (reliability monitor)
    per_src_reasons: dict[str, list[str]] = {}  # per-platform failure-reason codes (drift signal)
    needs_login_srcs: set[str] = set()     # platforms whose session died mid-run
    challenged_srcs: set[str] = set()      # platforms that flagged a captcha/challenge this run
    # Where this run's matches were routed, and how many extra page loads that
    # cost. per_channel is the coverage readout the shadow-mode rollout turns on:
    # what share of real listings have an employer-side intake we can use.
    per_channel: dict[str, int] = {}
    resolve_fetches = 0

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
        """_resume_for_role, with the guarantee its callers assume.

        Every call site sits OUTSIDE the try that wraps the apply itself, so
        anything raising in here took down the whole run — every remaining user
        in the sweep included. And nothing in here is worth that: the answer to
        any failure is "send the master resume untouched", which is already the
        answer to most of the paths below.
        """
        if not live:
            return None, None
        try:
            return _resume_for_role(title, company, job_skills, jd_text)
        except Exception as e:  # noqa: BLE001
            log.warning(
                "resume selection for %s @ %s failed (%s) — sending the master unchanged",
                title, company, e,
            )
            return master_pdf, None

    def _resume_for_role(
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

        Call it through _get_resume, which is the guarded entry point.
        """
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

        # The filename carries a digest of the EDIT, not only of the role.
        # `resume_versions` promises an immutable snapshot of the exact document a
        # recruiter received, but the row stores a path — so writing every
        # tailoring of this role to one `{ckey}.pdf` let the next run's edit
        # silently replace the bytes behind every earlier row pointing there. The
        # user would open last week's application and be shown this week's resume.
        # Identical LaTeX still lands on one file (nothing is lost by that); a
        # different edit gets its own.
        pdf = os.path.join(
            _tailored_dir, f"{ckey}_{hashlib.sha1(edited.encode()).hexdigest()[:10]}.pdf"
        )
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

    # 4a. Send the applications the user approved.
    #
    # Two routes out of this queue, and the difference is where the application
    # lands. A row resolved to an employer's own intake (Google Form, HR mailbox)
    # can be delivered outright — no account of the user's is involved. A row
    # that only exists on a board still hits Safe Apply Mode's fail-closed gate
    # and is held for the user's own browser, exactly as before.
    requeue_after_seconds = 0
    approved_apps = db.get_approved_applications(uid)
    if live and approved_apps:
        for approved_index, app_row in enumerate(approved_apps):
            if remaining <= 0:
                break
            src = app_row.get("source") or ""
            row_dest = {
                "channel": app_row.get("apply_channel") or resolver.CHANNEL_PLATFORM,
                "tier": app_row.get("apply_tier") or resolver.platform_tier(src),
                "target": app_row.get("apply_target") or "",
                "vendor": "",
                "evidence": "approved by the user",
            }
            employer_channel = row_dest["channel"] in _CHANNEL_MODULES and row_dest["target"]

            if employer_channel:
                send_ok, hold_reason = safety.destination_policy(row_dest)
            else:
                manual_final_submit, hold_reason = safety.requires_manual_final_submit(src)
                send_ok = not manual_final_submit
            if not send_ok:
                db.update_application_status(app_row["id"], "approved", hold_reason)
                db.add_audit("safe_apply_hold", user_id=uid, target=app_row.get("url"), detail=src)
                continue

            # A user tapped Approve on this — it MUST send, regardless of
            # today's discovery rotation. Rotation only limits which sites we
            # *scrape* for new jobs; it must never strand an already-approved
            # application (that would silently break the one-tap promise).
            # So load the platform module on demand for any connected
            # platform, even one not in today's rotated source_modules.
            # None of that applies to an employer channel: it needs no board
            # session at all, so a disconnected platform must not block it.
            mod = None
            if not employer_channel:
                if src not in connected_platforms:
                    # Platform genuinely not connected (session gone / never set) —
                    # can't submit; leave it approved for a run where it's connected.
                    #
                    # Say so on the row. Both of these `continue`s used to write
                    # nothing at all: the application sat on "approved" with its
                    # old reason, run after run, and the user was never told why
                    # their tap had produced nothing. An `src` of "" (an approved
                    # row whose job was deleted) can never match a connected
                    # platform, so that one waits forever by construction.
                    db.update_application_status(
                        app_row["id"], "approved",
                        f"waiting to send — reconnect {src or 'the platform'} and it goes out "
                        f"on the next run",
                    )
                    log.info("approved row %s waiting: %s not connected", app_row["id"], src or "(unknown)")
                    continue
                mod = source_modules.get(src)
                if mod is None:
                    mod = _load_module(src)
                    if mod is None:
                        db.update_application_status(
                            app_row["id"], "needs_review",
                            f"Grindly can't submit on {src} right now — open it and send it yourself",
                        )
                        log.warning("approved row %s: no adapter for %s", app_row["id"], src)
                        continue
                    source_modules[src] = mod  # so end-of-run close() cleans it up too
                if _platform_blocked(src):
                    # Stays 'approved', NOT 'matched'. get_approved_applications
                    # only reads status='approved', so downgrading it here meant
                    # the row never came back and the user's tap was discarded —
                    # while the reason text promised it would be retried.
                    db.update_application_status(
                        app_row["id"], "approved", f"{src} paused — captcha/challenge cooldown active",
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
            jd_text = _scrape_jd_if_available(src, mod, job["url"], uid) if mod else ""
            letter_key = (job["title"], job["company"])
            if letter_key not in letter_cache:
                letter_cache[letter_key] = cover_letter(name, job["title"], job["company"], skills, job, jd_text=jd_text)
            letter = letter_cache[letter_key]
            resume_path, vid = _get_resume(job["title"], job["company"], job["skills"], jd_text=jd_text)
            # An approved send spends a daily slot exactly like a discovery
            # send. This path used to skip the ledger entirely, so a user's
            # approvals sent past the cap the reservation exists to enforce —
            # and "Sent today" climbed while "Left today" never moved.
            slot_day = db.local_date_for(uid, profile.get("timezone"))
            if not db.reserve_daily_slot(uid, plan_cap, profile.get("timezone"), day=slot_day):
                db.update_application_status(
                    app_row["id"], "approved",
                    "approved — today's application limit is reached, it goes out tomorrow",
                )
                log.info("approved row %s waiting: daily cap reached", app_row["id"])
                continue
            rec: dict = {}
            try:
                status, why = _dispatch_apply(
                    row_dest, job, letter, uid, profile=apply_profile,
                    resume_path=resume_path, record=rec, skills=skills,
                    source_modules=source_modules,
                )
            except Exception as e:  # noqa: BLE001
                status, why = "failed", _user_facing_failure(e, src)
            # Same refund rule as the discovery loop: definite non-sends give
            # the slot back; an ambiguous submit after a real click stays spent.
            provably_not_sent = status == "needs_review" and not rec.get("submit_attempted")
            if status in ("failed", "skipped", "login_required") or provably_not_sent:
                db.release_daily_slot(uid, profile.get("timezone"), day=slot_day)
            # failure_reason is also the discriminator that marks a needs_review
            # re-scorable (db._PROVABLY_NOT_SENT) — set it on the same terms as
            # the discovery loop, or an approved row refused at the door would be
            # locked out of every future run.
            fr = _classify_failure(why) if status == "failed" or provably_not_sent else None
            if fr == safety.FAILURE_REASON.CAPTCHA and not employer_channel:
                _flag_challenge(src)
            if status == "login_required":
                # "login_required" is an ADAPTER return value, not a row status —
                # applications.status is a Postgres enum (ApplyStatus) that has no
                # such member, so writing it straight through raised and lost the
                # whole update. Record it the way the discovery loop already does:
                # back to matched, with the session-expired reason, and point the
                # user at the integration that actually needs reconnecting.
                login_src = "gmail" if row_dest["channel"] == resolver.CHANNEL_EMAIL else src
                db.set_integration_status(uid, login_src, "needs_login")
                needs_login_srcs.add(login_src)
                db.update_application_status(
                    app_row["id"], "matched", f"{why} — reconnect in dashboard",
                    failure_reason=safety.FAILURE_REASON.SESSION_EXPIRED,
                )
                db.add_audit("session_expired", user_id=uid, target=login_src)
                continue
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
            # Same refused-at-the-door fallback as the discovery loop: the user
            # tapped Approve, our server was shown a human-check — their own
            # browser is the next honest attempt, not a dead end.
            if provably_not_sent and _queue_browser_task(
                uid, row_dest, job.get("url") or "", plan["ready"],
                application_id=app_row["id"],
            ):
                log.info("approved row refused at the door — queued for the user's own browser: %s",
                         app_row["id"])
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
            elif status == "needs_review" and not provably_not_sent and (
                _SPREAD_APPLIES
                and remaining > 0
                and approved_index + 1 < len(approved_apps)
            ):
                # Only a real submit costs budget and needs pacing. A sender
                # refused at the door sent nothing to space out.
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

        # Scam gate (Layer 1): a legitimate internship never bills the applicant.
        # Block listings that demand a fee/deposit or are MLM/earnings traps before
        # they can ever be queued. Filed as skipped (hidden from the dashboard) so
        # the student is silently protected. Uses whatever JD text we already have —
        # never scrapes extra just for this.
        scam_reason = scam.scam_block(job, job.get("jd_text", ""))
        if scam_reason:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped",
                reason=f"scam risk: {scam_reason}", applied=False,
            )
            log.info("scam gate: skipped %s @ %s — %s", job.get("title"), job.get("company"), scam_reason)
            continue

        if score < plan["min_match_score"]:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped",
                reason=f"{reason} (below {plan['min_match_score']})", applied=False,
            )
            continue

        # Scam gate (Layer 2): reputation check on the company itself, only for
        # listings that cleared every cheap gate above and are about to be queued —
        # so the LLM runs at most ~cap times/run, and cached per company after that.
        # Returns None when no LLM is available (fail-open); only a high-confidence
        # scam verdict blocks. Never let a reputation-service hiccup abort the run.
        try:
            rep = company_rep.check_company(job["company"], job.get("jd_text", ""))
        except Exception as e:  # noqa: BLE001
            rep = None
            log.warning("reputation check errored for %s: %s", job.get("company"), e)
        if rep and rep.get("verdict") == company_rep.VERDICT_SCAM:
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped",
                reason=f"scam risk (reputation): {rep.get('evidence') or 'flagged by reputation check'}",
                applied=False,
            )
            log.info("scam gate L2: skipped %s @ %s — %s (conf %.2f)",
                     job.get("title"), job.get("company"), rep.get("evidence"), rep.get("confidence") or 0.0)
            continue

        matched += 1

        # ── Where does this application actually go? ────────────────────────
        #
        # A listing found on a board is usually a cross-post; the real intake is
        # often the employer's own Google Form, HR mailbox or ATS page, where the
        # candidate holds no account and an unattended submit therefore risks
        # nothing. Resolve that first, because it — not the board that found the
        # listing — decides whether the agent may send this without the user.
        jd_text = job.get("jd_text") or ""
        if live and not jd_text and resolve_fetches < RESOLVE_FETCH_BUDGET:
            # _scrape_jd_if_available tolerates a missing module and returns "".
            jd_text = _scrape_jd_if_available(src, source_modules.get(src), job["url"], uid)
            if jd_text:
                job["jd_text"] = jd_text
                resolve_fetches += 1

                # Re-run the scam gate now that we can actually READ the listing.
                #
                # Both gates above fired against whatever text the board's search
                # results happened to carry, which for most sources is nothing at
                # all — so a demand for a "registration fee" or an MLM pitch that
                # lives in the description body, which is exactly where it always
                # lives, sailed through unscanned. Worse, this JD is about to be
                # fed to the cover-letter writer and the resume tailorer, so the
                # agent would work up a tailored application for the scam and,
                # with auto-apply on, send it.
                #
                # Deliberately here rather than fetching earlier for everything:
                # the fetch is budgeted and only listings that cleared the cheap
                # gates are worth spending a page load on.
                scam_reason = scam.scam_block(job, jd_text)
                if scam_reason:
                    db.add_application(
                        uid, job_id=job_id, title=job["title"], company=job["company"],
                        url=job["url"], score=score, status="skipped",
                        reason=f"scam risk: {scam_reason}", applied=False,
                    )
                    log.info("scam gate (post-JD): skipped %s @ %s — %s",
                             job.get("title"), job.get("company"), scam_reason)
                    matched -= 1
                    continue
        allow_fetch = live and resolve_fetches < RESOLVE_FETCH_BUDGET
        dest, page_loads = _resolve_destination(job, jd_text, allow_fetch=allow_fetch)
        resolve_fetches += page_loads
        if dest["channel"] != resolver.CHANNEL_PLATFORM:
            log.info("routed %s @ %s -> %s (%s)", job.get("title"), job.get("company"),
                     dest["channel"], dest.get("evidence"))
        per_channel[dest["channel"]] = per_channel.get(dest["channel"], 0) + 1
        is_platform_channel = dest["channel"] == resolver.CHANNEL_PLATFORM

        auto_ok, policy_reason = safety.destination_policy(dest)
        # The user's own switch outranks the fleet switch. `auto_apply` is a
        # setting they can see and toggle ("Auto-apply applications" in the
        # profile), and it was being dropped on the floor — so turning routing on
        # for the fleet would have started sending applications for people who
        # had explicitly said not to. Consent has to survive a config change.
        if auto_ok and not plan["auto_apply"]:
            auto_ok = False
            policy_reason = (
                "auto-apply is off in your profile — the agent prepared this "
                "instead of sending it"
            )
        # Readiness, re-checked here rather than trusted from activation time.
        # The web gates the toggle, but the facts can change afterwards — consent
        # revoked, resume deleted, the consent wording bumped — and only the
        # check that runs immediately before dispatch actually protects anyone.
        # Not ready means PREPARED, never sent: the row banks like any other hold.
        if auto_ok and not plan["ready"]:
            auto_ok = False
            policy_reason = (
                "your setup isn't complete yet ("
                + ", ".join(plan["not_ready"])
                + ") — the agent prepared this instead of sending it"
            )
        # The board channel keeps its own fail-closed gate as a second lock: even
        # if a policy bug ever said yes for Tier C, Safe Apply Mode still says no.
        if is_platform_channel and _requires_approval(src, plan["auto_apply"]):
            auto_ok, policy_reason = False, safety.requires_manual_final_submit(src)[1]
        # "Allowed to send" and "able to send" are different questions. An ATS
        # destination is Tier A and permitted, and there is no ATS sender yet —
        # bank it here rather than letting it reach dispatch, where it would
        # spend a quota slot only to come back as needs_review.
        if auto_ok and not channel_deliverable(dest):
            auto_ok = False
            policy_reason = _UNDELIVERABLE_REASON.get(
                dest["channel"], "prepared — open it yourself to send it"
            )

        # No-touch mode: a match the agent cannot finish alone is not offered at
        # all. Dropped rather than banked, because banking is what puts a row on
        # the dashboard with a daily slot against its name and a tap waiting on
        # the user — the exact thing this mode exists to remove. Deliberately
        # placed AFTER the policy checks so `per_channel` still records what was
        # found: the operator needs to see what the mode is costing.
        if flags.no_touch_only() and not (auto_ok or channel_deliverable(dest)):
            log.info("no-touch mode: dropping %s @ %s (%s, tier %s)",
                     job.get("title"), job.get("company"),
                     dest.get("channel"), dest.get("tier"))
            matched -= 1
            continue

        if not auto_ok:
            # Bank it with a due date instead of dumping it on the dashboard.
            # `pipeline` is what was already queued before this run, so a second
            # sweep keeps filling days behind the existing queue rather than
            # piling another `cap` matches onto today.
            slot = pipeline + queued
            queued += 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — {policy_reason}", applied=False,
                scheduled_for=_release_at(slot, plan_cap),
                missing_skills=matcher.missing_skills(
                    job, skills, jd_text=job.get("jd_text", "")
                ),
                destination=dest,
            )
            # Held here means OUR servers may not send it — not that nobody can.
            # A page application is still completable in the user's own browser,
            # in their own session, with any CAPTCHA going to them. This includes
            # employer ATS/forms discovered through the open web: a disabled or
            # unsupported server sender must not turn a real apply URL into a
            # dead-end. Email is deliberately excluded because a browser page
            # cannot safely send an email on the user's behalf.
            #
            # This is the producer the executor consumes. Without it the claim
            # endpoint has nothing to hand out, which is how the browser executor
            # shipped complete, switched on, and did nothing at all: the queue was
            # empty by construction.
            if _queue_browser_task(uid, dest, job.get("url") or "", plan["ready"]):
                log.info("queued a browser task for %s @ %s",
                         job.get("title"), job.get("company"))
            continue

        if remaining <= 0:
            # Bank it behind the queue like every other match. Filing it with no
            # scheduled_for makes it due IMMEDIATELY (see the column's note in
            # prisma/schema.prisma), so a run that hit the cap would dump the
            # whole remaining sweep onto the dashboard at once — the exact
            # free-job-board / mass-apply outcome the pipeline exists to prevent.
            slot = pipeline + queued
            queued += 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — daily cap reached", applied=False,
                scheduled_for=_release_at(slot, plan_cap),
                missing_skills=matcher.missing_skills(
                    job, skills, jd_text=job.get("jd_text", "")
                ),
                destination=dest,
            )
            continue

        # Board-only pacing gates. An employer's own form is not the board and
        # has no shared rate limit with it, so a captcha cooldown or a per-run
        # board cap must not strand an application that never touches the board.
        #
        # Both bank through the pipeline, exactly like the two gates above. They
        # used to file with no scheduled_for, which means due IMMEDIATELY — so
        # hitting a captcha cooldown mid-sweep dumped every remaining match onto
        # the dashboard at once, the mass-apply outcome the pipeline exists to
        # prevent. Taking a slot matters just as much: without it the next banked
        # row reuses this `slot` and two matches land on the same release.
        if is_platform_channel and _platform_blocked(src):
            slot = pipeline + queued
            queued += 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — {src} paused (captcha/challenge cooldown)", applied=False,
                scheduled_for=_release_at(slot, plan_cap),
                destination=dest,
            )
            continue

        # per-platform safety cap — keep a human-like pace on any one platform
        if (is_platform_channel and SAFETY_CAP_PER_PLATFORM > 0
                and per_src_applied.get(src, 0) >= SAFETY_CAP_PER_PLATFORM):
            slot = pipeline + queued
            queued += 1
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{reason} — {src} per-run cap ({SAFETY_CAP_PER_PLATFORM}) reached",
                applied=False, scheduled_for=_release_at(slot, plan_cap),
                destination=dest,
            )
            continue

        # Attribute reliability stats to whatever was actually operated. Filing a
        # Google Form failure against "internshala" would fire a selector-drift
        # alert at an adapter that was never touched.
        stat_src = src if is_platform_channel else f"channel:{dest['channel']}"

        # apply
        #
        # Reserve the day's slot BEFORE sending, not after. The in-memory
        # `remaining` above bounds this one run; it cannot bound two runs racing
        # (a manual "Run now" while the scheduled sweep is mid-flight), and an
        # application that has been sent cannot be recalled. The reservation
        # makes the database the arbiter — see db.reserve_daily_slot.
        slot_held = False
        slot_day = ""
        if live and (not is_platform_channel or src in source_modules):
            # Prepare EVERYTHING fallible before the reservation. The JD scrape,
            # the LLM cover letter and the LaTeX resume compile all used to run
            # between reserve and dispatch, outside any try — a raise there (or
            # a container kill) escaped the loop with the slot held and NO
            # application row written: submitted+1 in daily_usage with nothing
            # anywhere to show for it.
            if not jd_text and is_platform_channel:
                jd_text = _scrape_jd_if_available(src, source_modules[src], job["url"], uid)
            letter_key = (job["title"], job["company"])
            if letter_key not in letter_cache:
                letter_cache[letter_key] = cover_letter(
                    name, job["title"], job["company"], skills, job, jd_text=jd_text
                )
            letter = letter_cache[letter_key]
            resume_path, vid = _get_resume(job["title"], job["company"], job.get("skills", []), jd_text=jd_text)
            # Pin the reservation's date so the release after an over-midnight
            # dispatch decrements the SAME row it incremented.
            slot_day = db.local_date_for(uid, profile.get("timezone"))
            slot_held = db.reserve_daily_slot(uid, plan_cap, profile.get("timezone"), day=slot_day)
            if not slot_held:
                log.info("daily cap reached (%d) — banking the rest of the queue", plan_cap)
                nslot = pipeline + queued
                queued += 1
                db.add_application(
                    uid, job_id=job_id, title=job["title"], company=job["company"],
                    url=job["url"], score=score, status="matched",
                    reason=f"{reason} — daily limit reached", applied=False,
                    scheduled_for=_release_at(nslot, plan_cap),
                    destination=dest,
                )
                remaining = 0
                continue
            rec = {}
            try:
                status, why = _dispatch_apply(
                    dest, job, letter, uid, profile=apply_profile,
                    resume_path=resume_path, record=rec, skills=skills,
                    source_modules=source_modules,
                )
            except Exception as e:  # noqa: BLE001
                status, why = "failed", _user_facing_failure(e, src)
        else:
            # No live module loaded for this listing's platform — never fabricate
            # an apply. Shortlist it so nothing fake reaches the dashboard.
            status, why, vid, rec = "skipped", f"{src} unavailable this run", None, {}

        # Give the slot back only when nothing reached the employer. "failed" and
        # "skipped" are definite non-sends. A needs_review is refunded ONLY when
        # the sender proves it never reached its point of no return
        # (record["submit_attempted"] unset — sender off, no resume, unreadable
        # form); after a real click it stays spent, or a flaky channel could
        # push the user past the number of applications they agreed to today.
        if slot_held and (
            status in ("failed", "skipped", "login_required")
            or (status == "needs_review" and not rec.get("submit_attempted"))
        ):
            db.release_daily_slot(uid, profile.get("timezone"), day=slot_day)
            slot_held = False

        if status == "applied":
            applied += 1
            remaining -= 1
            per_src_applied[stat_src] = per_src_applied.get(stat_src, 0) + 1
            applied_keys.add(dedup_key)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="applied", reason=why, applied=True,
                resume_version_id=vid,
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
                destination=dest,
            )
            db.add_audit("apply", user_id=uid, target=job.get("url"),
                         detail=f"{stat_src}:applied")
            # Timeline entry: "the agent sent this" has to stay distinguishable
            # from "you sent this" long after the status column says `applied`.
            db.add_application_event(
                _last_application_id(uid, job.get("url")), "submitted", actor="worker",
                meta={"channel": dest.get("channel"), "tier": dest.get("tier"), "source": stat_src},
            )
            if _SPREAD_APPLIES and remaining > 0:
                requeue_after_seconds = random.randint(*_SPREAD_GAP_SEC)
                log.info(
                    "spread mode: yielding worker for %ds before next apply",
                    requeue_after_seconds,
                )
                break
        elif status == "login_required":
            # Attribute the reconnect to the integration that actually expired.
            # An email-channel apply failing on Gmail auth must not mark the
            # board as logged out — that would send the user to reconnect a
            # platform that is working fine.
            login_src = "gmail" if dest["channel"] == resolver.CHANNEL_EMAIL else src
            db.set_integration_status(uid, login_src, "needs_login")
            needs_login_srcs.add(login_src)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="matched",
                reason=f"{why} — reconnect in dashboard", applied=False,
                failure_reason=safety.FAILURE_REASON.SESSION_EXPIRED,
                destination=dest,
            )
            db.add_audit("session_expired", user_id=uid, target=login_src)
        elif status == "skipped":
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="skipped", reason=why, applied=False,
                destination=dest,
            )
        elif status == "needs_review":
            # Two very different events share this status, and only the sender
            # knows which one happened — record["submit_attempted"] is how it
            # says so, the same signal that already decides whether the daily
            # slot and the idempotency claim are refunded.
            #
            #  * AMBIGUOUS (flag set): the submit click registered and we could
            #    not confirm the outcome. Do NOT count it a success (misreports
            #    accuracy) or a failure (skews the drift monitor). Spend the
            #    budget slot and dedup it like a real attempt so we never
            #    re-click an already-submitted form — surface it to verify.
            #  * PROVABLY NOT SENT (flag unset): the sender stopped at a known
            #    obstacle before its point of no return — a human-check on the
            #    page, an unanswerable required question. Nothing reached the
            #    employer, so it costs no budget and does not dedup: writing a
            #    failure_reason marks the row re-scorable (db._PROVABLY_NOT_SENT)
            #    so a later run, from a fixed sender or the user's own browser,
            #    can still get through. It stays needs_review because the user
            #    genuinely may want to open it themselves.
            ambiguous = bool(rec.get("submit_attempted"))
            if ambiguous:
                remaining -= 1
                per_src_applied[stat_src] = per_src_applied.get(stat_src, 0) + 1
                applied_keys.add(dedup_key)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="needs_review", reason=why,
                applied=False, resume_version_id=vid,
                failure_reason=None if ambiguous else _classify_failure(why),
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
                destination=dest,
            )
            # Refused at the door — hand it to the one browser that CAN pass.
            # The page demanded a human (a check, a question); the user's own
            # signed-in browser has a person, a session and a residential IP.
            # Without this, a web-found employer application only ever retried
            # from the same datacenter IP that was just refused.
            if not ambiguous and _queue_browser_task(uid, dest, job.get("url") or "", plan["ready"]):
                log.info("refused at the door — queued for the user's own browser: %s @ %s",
                         job.get("title"), job.get("company"))
            db.add_audit("apply_needs_review", user_id=uid, target=job.get("url"), detail=why[:120])
            # Pace only after something actually went out. A sender that was
            # refused at the door sent nothing to space out, and yielding the
            # worker for ten minutes over it burns the run's whole budget on
            # pages that never became applications.
            if ambiguous and _SPREAD_APPLIES and remaining > 0:
                requeue_after_seconds = random.randint(*_SPREAD_GAP_SEC)
                log.info(
                    "spread mode: yielding worker for %ds after ambiguous submit",
                    requeue_after_seconds,
                )
                break
        else:
            failed += 1
            per_src_failed[stat_src] = per_src_failed.get(stat_src, 0) + 1
            fr = _classify_failure(why)
            per_src_reasons.setdefault(stat_src, []).append(fr)
            # A challenge cooldown only means something for a board we keep a
            # session on; an employer form has no session to protect.
            if fr == safety.FAILURE_REASON.CAPTCHA and is_platform_channel:
                _flag_challenge(src)
            db.add_application(
                uid, job_id=job_id, title=job["title"], company=job["company"],
                url=job["url"], score=score, status="failed", reason=why, applied=False,
                resume_version_id=vid, failure_reason=fr,
                screenshot_path=rec.get("screenshot_path"),
                answers_json=rec.get("answers"),
                destination=dest,
            )
            db.add_audit("apply_failed", user_id=uid, target=job.get("url"), detail=why[:120])

        if live:
            time.sleep(random.uniform(*_BASE_PACE_SEC))

    # Routing coverage for this run. This is the number that decides where the
    # rest of the auto-apply work goes: if most listings resolve to an employer
    # channel, unattended applying is mostly solved; if they don't, the fix is
    # more Tier A *sourcing*, not more automation against the boards. Logged
    # every run (including shadow mode, where nothing was sent) so the answer
    # accumulates from real traffic rather than from an estimate.
    if per_channel:
        total_routed = sum(per_channel.values())
        employer = total_routed - per_channel.get(resolver.CHANNEL_PLATFORM, 0)
        log.info(
            "routing coverage: %d/%d (%d%%) to an employer channel — %s [mode=%s]",
            employer, total_routed, int(100 * employer / total_routed),
            ", ".join(f"{k}={v}" for k, v in sorted(per_channel.items())),
            safety.auto_apply_mode(),
        )
        db.add_audit(
            "routing_coverage", user_id=uid,
            target=f"{employer}/{total_routed}",
            detail=json.dumps(per_channel),
        )

    # per-platform reliability check. Split genuine selector drift (our adapter
    # is broken — page an engineer) from transient/user-side failures (captcha,
    # expired session — noise that a reconnect fixes). See agent/drift.py.
    for src in set(list(per_src_applied) + list(per_src_failed)):
        attempts = per_src_applied.get(src, 0) + per_src_failed.get(src, 0)
        if attempts < 3:
            continue
        report = drift.assess_source(src, attempts, per_src_reasons.get(src), min_attempts=3)
        rate = per_src_failed.get(src, 0) / attempts
        if report.alert:
            log.error(
                "SELECTOR DRIFT on %s: %d/%d selector-missing (%d%%) — adapter needs updating",
                src, report.selector_failures, attempts, int(report.selector_share * 100),
            )
            db.add_audit("selector_drift", user_id=uid, target=src,
                         detail=f"{report.selector_failures}/{attempts} selector-missing")
            notify.send(_OPS_CHANNEL, report.message())
        elif rate > _FAIL_RATE_WARN:
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

    # Apply Kit backfill — attach a tailored resume, cover letter, and (where the
    # platform supports a read-only visit) drafted screening answers to every due
    # match that doesn't have one yet. This runs every live run regardless of
    # whether TODAY did fresh discovery: a batch banked weeks ago still needs its
    # kit generated close to when the user will actually see it, not only on the
    # day it was first found. Purely additive — never changes a row's status or
    # reason, never fills or submits anything on the platform itself.
    if live:
        for row in db.due_matches_missing_kit(uid):
            job_skills = _jlist(row.get("job_skills"))
            job = {
                "title": row["job_title"], "company": row["company"],
                "url": row.get("url") or "", "skills": job_skills,
            }
            vid, letter = None, None
            try:
                _, vid = _get_resume(job["title"], job["company"], job_skills)
                letter = cover_letter(name, job["title"], job["company"], skills, job)
            except Exception as e:  # noqa: BLE001
                log.warning("kit generation failed for application %s: %s", row["id"], e)

            answers_json = None
            src = row.get("source") or ""
            if src and src in connected_platforms and not _platform_blocked(src):
                mod = source_modules.get(src)
                if mod is None:
                    mod = _load_module(src)
                    if mod is not None:
                        source_modules[src] = mod
                if mod is not None:
                    answers_json = _prepare_answers_if_available(
                        src, mod, job["url"], uid, apply_profile, skills, job,
                    )

            if vid or letter or answers_json:
                db.set_application_kit(
                    row["id"], resume_version_id=vid,
                    cover_letter_text=letter, answers_json=answers_json,
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
    # Two different numbers, and conflating them is how a report starts lying.
    # `sent_by_agent` is what the agent delivered to an employer's own intake
    # with no user involvement; `ready` is what still needs the user because it
    # only exists on a board that holds their account. Report both, and never
    # describe one as the other.
    sent_by_agent = applied
    submitted_bit = f"{sent_by_agent} sent by the agent today. " if sent_by_agent else ""
    summary = (
        f"{submitted_bit}{ready} match(es) ready for you to prepare and submit. "
        f"{depth} lined up over the coming weeks."
    )
    db.add_report(uid, date=today, matched=matched, applied=applied, failed=failed,
                  summary=summary, delivered=True)

    sources_used = ", ".join(source_modules.keys()) if source_modules else "your queue"
    approve_nudge = (
        "\n\n:point_right: The ones still waiting are on boards that hold your "
        "account (LinkedIn/Internshala/Naukri/Unstop/Indeed) — I never click the "
        "final submit there. Open the dashboard, prepare a match, then send it "
        "from your own browser."
        if ready
        else ""
    )
    applied_bit = (
        f"  ·  :white_check_mark: Sent by the agent: {sent_by_agent}" if sent_by_agent else ""
    )
    msg = (
        f":robot_face: *Grindly daily report — {today}*\n"
        f":inbox_tray: Ready for you: *{ready}*{applied_bit}  ·  "
        f":x: Failed: {failed}\n"
        f"Sources: {sources_used}\n\n"
        f"{summary}\n\nI'll keep working through your queue. Pause anytime from the "
        f"dashboard.{approve_nudge}"
    )
    # A report nobody receives is the same as no agent at all, so an undeliverable
    # one is an operational failure, not a cosmetic one. Say so loudly — the whole
    # point of the delivered flag is that a mute production install stops looking
    # exactly like a working one.
    # Once per user per LOCAL day. Several runs a day is normal (the scheduler
    # plus any "Run now"), and each one delivering its own "daily" report meant
    # the same user got three different summaries before lunch — which reads as
    # a malfunction, not a service. Later runs still write their row above; they
    # just stop announcing it.
    if db.report_already_sent(uid, today):
        log.info("daily report for %s already delivered — not repeating it", today)
    elif not flags.daily_report_enabled():
        # Flagged off is an operator's choice, not a delivery failure: the report
        # row above is still written (counts stay truthful) and no ops alarm fires.
        log.info("daily report suppressed by GRINDLY_DAILY_REPORT_ENABLED=0")
    elif not notify.to_user(user, f"Grindly daily report — {today}", msg):
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


def _keep_existing_variants(uid: str, lead: str) -> bool:
    """A run that produced nothing must not delete the batch already on the card.

    The scores this feature compares wander several points on the same document
    (the user's master re-scored 70, 76 and 88 across three runs), so an empty
    result is often just an unlucky draw. Returns True when a previous batch was
    kept — the caller is done and must not write a failure status over it.
    """
    try:
        kept = db.count_resume_variants(uid)
    except Exception:  # noqa: BLE001 — never fail a run over a bookkeeping read
        log.exception("optimize: could not count existing variants for %s", uid)
        return False
    if not kept:
        return False
    db.set_variant_status(
        uid, "ready",
        f"{lead}, so your {kept} existing version(s) are still here. "
        f"Regenerate any time — the rewrites differ each run.",
    )
    return True


def optimize_variants(uid: str) -> dict:
    """Generate up to 3 ATS-optimized, compiled, measured-higher-scoring versions
    of the user's master resume. Runs ONLY on an explicit dashboard click (this is
    several LLM calls + Tectonic compiles), never on a sweep.

    Honest outcomes, all non-error:
      ready   — one or more variants beat the master; stored + shown.
      no_gain — we produced variants but none scored higher, OR the LLM/compiler
                was unavailable. We show nothing rather than a worse resume.
      failed  — no resume text to work from.

    The compiled PDFs land in data/resume_variants/<uid>/; the DB rows (see
    db.save_resume_variants) hold the score, the plain-English change list, and the
    path. Nothing here fabricates content — resume_optimize enforces a truthfulness
    gate before a variant is ever compiled.
    """
    user = db.get_user(uid)
    if not user:
        # Still write a terminal status. The web set "generating" before enqueueing
        # this run, and every early return that skips the write leaves the card on
        # "Building…" with no way back but re-uploading the master resume.
        log.warning("optimize: no user %s", uid)
        db.set_variant_status(uid, "error", "Couldn't load your profile — try again.")
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
        db.set_variant_status(uid, "failed", "No readable resume text to optimize yet.")
        return {"status": "failed", "detail": "no resume text"}

    skills = _jlist(profile.get("skills"))
    if not skills:
        skills = resume_parse.extract_skills(text)

    db.set_variant_status(uid, "generating", "Building optimized versions…")
    # Failed compiles/renders leave their .tex + .pdf here — the only way to tell
    # an empty document from an unextractable one after the fact.
    debug_dir = os.path.join(_ROOT_DIR, "data", "logs", "optimize", uid)
    # Last-resort header if the resume's own text has no readable contact line.
    # The generator reads identity off the RAW resume because the LLM boundary
    # redacts PII — a variant built from what the model saw ships a header reading
    # "[phone redacted] | [email redacted]" and no employer can reply to it.
    contact_fallback = " | ".join(
        p for p in [str(profile.get("phone") or "").strip(), str(user.get("email") or "").strip()] if p
    )
    try:
        batch = resume_optimize.generate_variants(
            text, skills, debug_dir=debug_dir, contact_fallback=contact_fallback
        )
    except Exception as e:  # noqa: BLE001 — a generation crash must degrade, not kill the worker
        log.exception("optimize: generation failed for %s", uid)
        # NOT "no_gain": this is our failure, and telling the user their resume
        # was too good to improve when the generator crashed is a lie they act on.
        db.set_variant_status(uid, "error", "Something broke while building your versions — try again, and tell support if it repeats.")
        return {"status": "error", "detail": str(e)}

    variants = batch.get("variants") or []
    reasons = batch.get("reasons") or []
    aborted = batch.get("aborted")

    if aborted:
        # Deliberately NOT clearing the stored batch. A run that fails on our side
        # says nothing about versions the user already has, and those describe the
        # same master (a new upload clears them in the web layer). Deleting them
        # here meant one unlucky Regenerate wiped a good set and left the card
        # empty.
        if _keep_existing_variants(uid, "This run couldn't finish"):
            return {"status": "ready", "detail": aborted}
        detail = {
            "source_too_short": "We couldn't read enough text out of your resume to rebuild it. Upload a text-based PDF or DOCX (not a scan).",
            "no_compiler": "The resume builder is unavailable on our side right now — this is not your resume. Try again shortly.",
            "extraction_failed": "We couldn't break your resume into sections to rebuild it. Try again, or tell support if it repeats.",
        }.get(aborted, "Couldn't build optimized versions this time — try again.")
        status = "no_gain" if aborted == "source_too_short" else "error"
        db.set_variant_status(uid, status, detail)
        log.warning("optimize: %s aborted (%s)", uid, aborted)
        return {"status": status, "detail": aborted}

    if not variants:
        if _keep_existing_variants(uid, "This run didn't beat your current resume"):
            log.info("optimize: %s produced nothing; kept the existing batch", uid)
            return {"status": "ready", "reasons": reasons}
        # Say WHY each one dropped. "Your resume already scores well" was being
        # shown even when every variant died on an unreadable compile — a beta
        # user read that, believed the feature had run, and filed a bug.
        why = " · ".join(reasons[:3]) if reasons else "no versions survived scoring"
        # "model unavailable" is in this list because it was missing: with no LLM
        # provider reachable, every rewrite returned nothing, and the message
        # shown was "none of the rewrites beat your current resume" — a claim
        # about the user's resume when the truth was our model being down.
        ours = any(
            "our side" in r or "didn't compile" in r or "model unavailable" in r
            for r in reasons
        )
        db.set_variant_status(
            uid,
            "error" if ours else "no_gain",
            ("Couldn't produce a usable version this time. " if ours
             else "None of the rewrites beat your current resume without changing the facts. ")
            + why,
        )
        log.info("optimize: %s produced nothing — %s", uid, why)
        return {"status": "error" if ours else "no_gain", "reasons": reasons}

    # Persist the compiled PDFs to disk, then record the rows. Wipe the user's old
    # variant dir first so a smaller new batch can't leave orphaned files behind.
    out_dir = os.path.join(_ROOT_DIR, "data", "resume_variants", uid)
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(out_dir, exist_ok=True)
    for i, v in enumerate(variants, start=1):
        fname = f"{i}.pdf"
        with open(os.path.join(out_dir, fname), "wb") as f:
            f.write(v.pop("pdf_bytes"))
        # Store a project-root-relative POSIX path; the web route resolves it under
        # process.cwd() and validates it stays inside data/resume_variants.
        v["pdf_path"] = f"data/resume_variants/{uid}/{fname}"

    base_hash = _resume_hash(text)
    db.save_resume_variants(uid, base_hash, variants)
    best = variants[0]["score"]
    baseline = int(batch.get("baseline") or 0)
    winners = sum(1 for v in variants if v.get("beats_baseline"))
    if winners:
        detail = f"{winners} version(s) beat your {baseline} — best scores {best}."
    else:
        # Only ties reach here: a variant that scored BELOW the master is discarded
        # in resume_optimize, not shown. Offering a worse resume behind the same
        # "Use as my resume" button is how a 35/F rebuild ended up beside a real 76.
        detail = (f"These land level with your current {baseline} (best {best}) rather than "
                  f"beating it — same facts on a cleaner, parser-friendly layout.")
    db.set_variant_status(uid, "ready", detail)
    log.info("optimize: %s stored %d variant(s), %d beat baseline %d, best=%d",
             uid, len(variants), winners, baseline, best)
    return {"status": "ready", "count": len(variants), "best": best, "winners": winners}


def scan_email(uid: str) -> dict:
    """Read the user's Gmail for interview/offer/rejection replies and update
    Application.outcome — the automatic half of interview tracking.

    Gated on GMAIL_SCAN_ENABLED. gmail.readonly is a Google-restricted scope, so
    until the OAuth app clears verification this stays dark in production and the
    dashboard offers manual outcome marking instead. It runs HERE on the worker —
    not in the web request — because the slim web image ships neither Python nor
    an LLM, which is why the old /api/gmail/scan route 503s in prod.

    Opt-in by construction: it only ever touches a user who deliberately connected
    Gmail (a credential row exists). Best-effort throughout — a failed scan must
    never surface as a broken agent run.
    """
    if os.environ.get("GMAIL_SCAN_ENABLED") != "1":
        return {"skipped": "disabled"}
    blob = db.get_platform_credential(uid, "gmail")
    if not blob:
        return {"skipped": "not_connected"}
    try:
        import secret_box
        import email_scanner
        creds = json.loads(secret_box.decrypt_secret(blob))
        rt = creds.get("refresh_token")
        if not rt:
            return {"skipped": "no_refresh_token"}
        result = email_scanner.scan(uid, rt)
        log.info("gmail scan for %s: scanned=%s detected=%d", uid,
                 result.get("scanned"), len(result.get("detected") or []))
        return result
    except Exception as e:  # noqa: BLE001
        log.warning("gmail scan failed for %s: %s", uid, e)
        return {"error": "scan_failed"}


def run_job(uid: str, mode: str) -> dict:
    """Queue dispatcher so the web app can ENQUEUE work instead of spawning
    Python itself:
      'analyze'              → resume analysis only
      'optimize'             → generate ATS-optimized resume variants (button-click)
      'scan_email'           → Gmail interview/offer/rejection detection (opt-in)
      'connect_<platform>'   → credential login for that platform (hosted)
      'approved'             → submit only the applications the user approved
      anything else          → full apply pipeline.
    Used by both --drain and --serve."""
    if mode == "analyze":
        return analyze_only(uid)
    if mode == "optimize":
        return optimize_variants(uid)
    if mode == "latex_check":
        return latex_check(uid)
    if mode == "scan_email":
        return scan_email(uid)
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
    #
    # try/finally here, not inside run_for_user: that function is long with
    # many early returns, and any exception raised between opening a platform
    # browser context (source_modules) and its own end-of-run close() block
    # skipped cleanup entirely — leaking a headed Chromium process for the
    # life of this long-running `worker.py --serve` process. close(uid) on
    # each adapter is a safe no-op if that adapter has nothing open for this
    # user (see internshala.close et al — dict.pop(key, None)), so calling all
    # of them unconditionally here is cheap insurance regardless of which
    # adapter(s) this run actually touched or where it failed.
    try:
        return run_for_user(uid, mode, manual=True)
    finally:
        _close_all_adapter_contexts(uid)


def _close_all_adapter_contexts(uid: str) -> None:
    for modname in ("internshala", "linkedin", "naukri", "unstop", "indeed"):
        try:
            mod = importlib.import_module(modname)
            mod.close(uid)
        except Exception:  # noqa: BLE001
            log.exception("failed to close %s browser context for %s", modname, uid)


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
