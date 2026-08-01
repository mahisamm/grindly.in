"""The thing that makes Grindly a daily product instead of a button.

Nothing in the system enqueued work on its own. `worker.py --serve` only DRAINS
the run queue; it never fills it. So the agent ran exactly when the user pressed
"Run agent" and at no other time — which means "your agent applies for you every
day" was, in fact, false.

This service fills the queue. One `live` run per active user per day.

Two things it is careful about:

  1. Every user does NOT get swept at 09:00. That would send our entire fleet at
     Internshala in the same minute each morning, from one IP block — a pattern
     that is trivially obvious from their side and has nothing to do with how
     careful any individual run is. Each user gets a stable-but-arbitrary hour
     within the working day, derived from their id and the date.

  2. It does not spam the queue. A user who already has a live run today (queued,
     running, or finished) is skipped, so a restart of this container does not
     re-enqueue the world.

The run it enqueues is cheap when there is nothing to do: worker.run_for_user
skips discovery entirely when the pipeline is already full, so a daily sweep on a
user with a month of banked matches costs one DB query, not five scraped job
boards. That is what makes "just enqueue every day" the right policy rather than a
wasteful one.

Usage:  python sweep.py --serve
"""
from __future__ import annotations

import argparse
import datetime
import logging
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))

import db
import run_queue

logging.basicConfig(
    format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
    level=logging.INFO,
)
log = logging.getLogger("grindly.sweep")

# The window inside which a user's daily sweep may be scheduled. Deliberately
# ends before worker.HUMAN_HOURS_END (21:00 IST) so a run that starts at its
# assigned hour still has room to finish inside human hours — a sweep kicked off
# at 20:55 would spend most of its life in the small hours, which is the exact
# bot tell the human-hours gate exists to avoid.
SWEEP_HOUR_START = int(os.environ.get("GRINDLY_SWEEP_HOUR_START", "9"))
SWEEP_HOUR_END = int(os.environ.get("GRINDLY_SWEEP_HOUR_END", "18"))

# When the fleet-wide board harvest runs (IST). Before the earliest user sweep
# on purpose: a board learned at 07:00 is polled by everyone's run that same
# day, whereas one learned at noon helps nobody until tomorrow.
#
# Once a day for the WHOLE FLEET, not once per user. A board is not personal —
# a thousand users searching out the same Bangalore startups is a thousand
# times the traffic for one answer, from one IP, which is the pattern that gets
# that IP blocked.
HARVEST_HOUR = int(os.environ.get("GRINDLY_HARVEST_HOUR", "7"))
HARVEST_ENABLED = os.environ.get("GRINDLY_HARVEST_ENABLED", "1") == "1"

# How long a listing survives without being seen by any crawl before it is
# treated as closed. Three weeks: long enough that a posting missed by a couple
# of search runs is not retired for it, short enough that the pool is not mostly
# ghosts. Reversible — a later sighting brings the listing straight back.
LISTING_TTL_DAYS = int(os.environ.get("GRINDLY_LISTING_TTL_DAYS", "21"))

# How many unrouted listings one daily pass tries to work out an apply route
# for. Each one can cost a page fetch from a real employer, so this is a
# politeness budget as much as a performance one: the backlog drains over days,
# and a listing only ever needs resolving once.
ROUTE_PASS_LIMIT = int(os.environ.get("GRINDLY_ROUTE_PASS_LIMIT", "150"))

# Keywords the fleet-wide listing harvest ranks by. Deliberately broad: the
# India-internship decision is made by atsboards._wanted(), and these only order
# what it kept. A narrow list here would quietly bias the SHARED pool toward
# whichever domains the author happened to think of, for every user at once.
FLEET_KEYWORDS = [
    "intern", "internship", "trainee", "software", "developer", "engineer",
    "data", "analyst", "machine learning", "design", "marketing", "product",
    "business", "finance", "operations", "content", "research", "sales",
]

# How many listings one fleet harvest keeps. The pool is shared, so this is a
# fleet-wide number rather than a per-user one.
FLEET_HARVEST_LIMIT = int(os.environ.get("GRINDLY_FLEET_HARVEST_LIMIT", "400"))
_last_harvest_date: str | None = None

# How often to check whether anyone is due. Ten minutes is far finer than the
# once-a-day decision it is making; it just needs to not miss an hour boundary.
POLL_SEC = int(os.environ.get("GRINDLY_SWEEP_POLL_SEC", "600"))


def _ist_now() -> datetime.datetime:
    return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=5, minutes=30)


def sweep_hour(uid: str, today: str) -> int:
    """The hour (IST) this user's daily sweep is due.

    Seeded by uid+date so it is stable across restarts within a day — otherwise a
    container restart would reroll every user's hour and could fire a second sweep
    — but rolls to a different hour tomorrow, and differs between users today.
    """
    rng = random.Random(f"{uid}:{today}:sweep")
    return rng.randint(SWEEP_HOUR_START, SWEEP_HOUR_END)


def sweep_hours(uid: str, today: str, plan: str = "free") -> list[int]:
    """Every slot hour this user gets today. One for free/plus; two for pro.

    Pro's 15/day cannot come out of a single discovery pass — one pass surfaces
    a morning's worth of fresh sendable listings, and the cap math needs
    roughly three evaluated listings per send. A second pass in the afternoon
    doubles supply without making any single run longer, and both hours stay
    seeded per-user so the fleet never converges on one minute.
    """
    if plan != "pro":
        return [sweep_hour(uid, today)]
    rng = random.Random(f"{uid}:{today}:sweep2")
    midpoint = (SWEEP_HOUR_START + SWEEP_HOUR_END) // 2
    return [
        rng.randint(SWEEP_HOUR_START, midpoint),
        rng.randint(midpoint + 1, SWEEP_HOUR_END),
    ]


def due_users(now: datetime.datetime | None = None) -> list[str]:
    """Active users owed a sweep: more slot hours have passed than runs have
    happened. The count comparison is what lets Pro's afternoon slot fire
    exactly once — and keeps a container restart from re-enqueueing anyone."""
    now = now or _ist_now()
    today = now.date().isoformat()
    out: list[str] = []
    for uid in db.active_users():
        hours = sweep_hours(uid, today, db.get_user_plan(uid))
        passed = sum(1 for h in hours if now.hour >= h)
        if passed <= 0:
            continue
        if db.live_runs_today(uid) >= passed:
            continue
        out.append(uid)
    return out


def _gmail_scan_on() -> bool:
    """Global switch for the opt-in Gmail interview scan. Off until gmail.readonly
    clears Google verification — see src/lib/googleOAuth.gmailScanEnabled, the web
    side of the same flag."""
    return os.environ.get("GMAIL_SCAN_ENABLED") == "1"


def harvest_due(now: datetime.datetime | None = None) -> bool:
    """True once per day, from HARVEST_HOUR onwards.

    Guarded by an in-process date rather than a database row because the
    harvest is idempotent and cheap to skip: the worst case of forgetting
    across a restart is one extra sweep, while a row would need a schema and a
    migration to protect against nothing.
    """
    if not HARVEST_ENABLED:
        return False
    now = now or _ist_now()
    return now.hour >= HARVEST_HOUR and _last_harvest_date != now.date().isoformat()


def run_harvest(now: datetime.datetime | None = None) -> dict | None:
    """One fleet-wide board harvest, if today's has not happened yet."""
    global _last_harvest_date
    if not harvest_due(now):
        return None
    now = now or _ist_now()
    # Marked BEFORE the sweep, not after: a harvest that throws halfway has
    # still spent its search budget, and retrying it every ten minutes for the
    # rest of the day is how one bad afternoon becomes a rate-limited IP.
    _last_harvest_date = now.date().isoformat()
    # Before the harvest, not after: the harvest re-sights everything still
    # live, so anything it is about to find has its last_seen_at refreshed a
    # moment later. Running expiry afterwards would retire listings the same
    # run had just confirmed were alive.
    retire_stale_listings(now)
    try:
        import harvester

        result = harvester.sweep()
        db.add_audit(
            "board_harvest", user_id=None,
            target=f"{result['learned']}/{result['candidates']}",
            detail=f"{result['known_after']} boards known",
        )
        # Board harvest found the BOARDS. This asks those boards what they are
        # actually advertising and puts it in the shared pool — the step that
        # used to happen only inside a user's run, so the index could not grow
        # unless somebody was already being served by it.
        result["listings"] = harvest_listings()
        # Last: the two steps above have just added today's listings, and those
        # are exactly the ones with no route yet. Running this first would work
        # through yesterday's backlog and leave every new arrival for tomorrow.
        result["routes"] = resolve_routes()
        return result
    except Exception as e:  # noqa: BLE001 — the fleet's runs matter more
        log.error("board harvest failed: %s", e)
        return None


def retire_stale_listings(now: datetime.datetime | None = None) -> int:
    """Retire pool listings no crawl has seen for weeks. Returns how many.

    Without this the shared index only ever grows, and the agent spends a user's
    daily quota applying to roles that closed months ago — which, from the
    dashboard, looks exactly like an agent that is working fine.

    Postings are rarely deleted when they close; they simply stop being returned
    by search. So "nobody has seen this in three weeks" is the strongest signal
    available, and it is self-correcting: upsert_job clears dead_at the moment a
    crawl finds the listing again.

    Rides the harvest's once-a-day guard rather than owning a schedule. It is a
    single indexed UPDATE, so running it beside the harvest costs nothing, and
    an expiry pass that runs on every ten-minute tick would be pure noise.
    """
    try:
        n = db.expire_unseen_jobs(LISTING_TTL_DAYS)
    except Exception as e:  # noqa: BLE001 — the fleet's runs matter more
        log.error("listing expiry failed: %s", e)
        return 0
    if n:
        log.info("retired %d listing(s) unseen for %d days", n, LISTING_TTL_DAYS)
        db.add_audit("listings_retired", user_id=None, target=str(n),
                     detail=f"unseen for {LISTING_TTL_DAYS} days")
    return n


def harvest_listings() -> dict:
    """Poll the board index into the shared pool, for nobody in particular.

    The gap this closes is structural and was invisible until the index got
    big: board polling only ever happened inside a USER's run. So the pool could
    not grow unless somebody was already being served by it — and the 8,469
    boards the tenant enumerator just found would have sat unpolled, because
    production currently has no active user at all.

    That is backwards for a shared index. Which employers are hiring is not a
    fact about any user, the listings land in one table everyone reads, and the
    work should therefore happen once, on a schedule, whether or not anyone is
    logged in. A new user should arrive to a full pool rather than spend their
    first week filling it.

    Broad keywords on purpose. atsboards._wanted() is what actually decides
    whether a posting is an India internship; the keywords only rank what it
    kept, and a narrow set here would bias the shared pool toward whatever the
    author happened to type.
    """
    try:
        import atsboards
    except Exception as e:  # noqa: BLE001
        log.error("listing harvest could not import atsboards: %s", e)
        return {"found": 0, "stored": 0}

    out = {"found": 0, "stored": 0}
    try:
        jobs = atsboards.fetch(FLEET_KEYWORDS, limit=FLEET_HARVEST_LIMIT)
    except Exception as e:  # noqa: BLE001
        log.error("listing harvest failed: %s", e)
        return out

    out["found"] = len(jobs)
    for job in jobs:
        try:
            db.upsert_job({
                "source": "atsboards",
                "external_id": job.get("external_id") or "",
                "title": job.get("title") or "",
                "company": job.get("company") or "",
                "location": job.get("location"),
                "stipend": job.get("stipend"),
                "duration": job.get("duration"),
                "skills": job.get("skills") or [],
                "url": job.get("url") or "",
            })
            out["stored"] += 1
        except Exception as e:  # noqa: BLE001
            # One malformed posting must not cost the rest of the harvest.
            log.debug("could not store %s: %s", job.get("url"), e)

    log.info("listing harvest: %d found, %d stored", out["found"], out["stored"])
    db.add_audit("listing_harvest", user_id=None,
                 target=str(out["stored"]), detail=f"{out['found']} returned")
    return out


def resolve_routes(limit: int = ROUTE_PASS_LIMIT) -> dict:
    """Work out how to apply to listings nobody has looked at yet.

    Deciding a listing's apply route is fleet work: it depends only on the
    posting, and its answer is the same for every user. It was being done
    lazily, on the first user to match — which is correct but has two costs that
    only show up at scale.

    The first is measurable and was: `capacity.py` reported ZERO sendable
    listings against a live pool of 298, because no route had ever been
    resolved. A pool the agent does not know how to apply to is not capacity,
    however large it looks, and quoting it as such is the exact optimism the
    capacity readout exists to remove.

    The second is that the first user to match any listing paid for the fetch,
    inside their own run, against their own page budget. Doing it here moves
    that cost off every user's critical path onto a fleet job nobody is waiting
    for.

    Bounded per pass, because this issues real requests to real employers. The
    backlog drains across days; the pool it is draining only has to be resolved
    once.
    """
    import resolver
    import websource

    out = {"looked_at": 0, "routed": 0, "no_route": 0, "failed": 0}
    try:
        pool = [j for j in db.live_jobs(limit=limit * 4) if not j.get("apply_channel")]
    except Exception as e:  # noqa: BLE001
        log.error("route pass could not read the pool: %s", e)
        return out

    for job in pool[:limit]:
        out["looked_at"] += 1
        jd = job.get("jd_text") or ""
        try:
            if not jd:
                jd = websource.scrape_jd(job.get("url") or "") or ""
                if jd:
                    db.set_job_jd(job["id"], jd)
        except Exception as e:  # noqa: BLE001
            log.debug("route pass could not read %s: %s", job.get("url"), e)
            out["failed"] += 1
            continue

        try:
            dest = resolver.resolve(job, jd)
        except Exception as e:  # noqa: BLE001
            log.debug("route pass could not resolve %s: %s", job.get("url"), e)
            out["failed"] += 1
            continue

        # A CHANNEL_PLATFORM verdict is deliberately not stored, for the same
        # reason worker.shared_destination refuses to cache one: it means "we
        # looked and found nothing better", which is often a product of the
        # moment rather than a fact about the listing.
        if dest.get("channel") and dest["channel"] != resolver.CHANNEL_PLATFORM:
            db.set_job_route(job["id"], dest["channel"], dest.get("target"),
                             dest.get("tier"), dest.get("vendor"))
            out["routed"] += 1
        else:
            out["no_route"] += 1

    if out["looked_at"]:
        log.info("route pass: %d looked at, %d routed, %d no route, %d failed",
                 out["looked_at"], out["routed"], out["no_route"], out["failed"])
        db.add_audit("route_pass", user_id=None,
                     target=f"{out['routed']}/{out['looked_at']}",
                     detail=f"{out['no_route']} without an employer-side route")
    return out


def tick(now: datetime.datetime | None = None) -> int:
    """Enqueue daily discovery and due final-link delivery work."""
    n = 0
    scan_on = _gmail_scan_on()
    for uid in due_users(now):
        try:
            run_queue.enqueue(uid, "live")
            db.add_audit("sweep_enqueued", user_id=uid, detail="daily sweep")
            log.info("enqueued daily run for %s", uid)
            n += 1
        except Exception as e:  # noqa: BLE001
            # One user's failure must not stop the rest of the fleet being swept.
            log.error("could not enqueue %s: %s", uid, e)
            continue
        # Opt-in Gmail interview scan, on the SAME once-a-day cadence as the sweep
        # (due_users already dedups per user per day). Only for users who actually
        # connected Gmail, and only when the feature is switched on. Isolated in its
        # own guard so a scan-enqueue hiccup never disturbs the live run just queued.
        if scan_on:
            try:
                if db.get_platform_credential(uid, "gmail"):
                    run_queue.enqueue(uid, "scan_email")
                    n += 1
            except Exception as e:  # noqa: BLE001
                log.error("could not enqueue gmail scan for %s: %s", uid, e)
    # Delivery runs contain no browser automation. The queue's per-user, per-mode
    # active key makes this safe to evaluate on each 10-minute sweep tick.
    for uid in db.active_users():
        try:
            if db.has_due_unnotified_match(uid):
                run_queue.enqueue(uid, "deliver")
                n += 1
        except Exception as e:  # noqa: BLE001
            log.error("could not enqueue delivery for %s: %s", uid, e)

    # LAST, deliberately. The harvest issues a few hundred searches and takes
    # minutes; the enqueues above take milliseconds and are what a user is
    # actually waiting on. Ordering costs nothing — the harvest hour is before
    # the first user sweep hour, so there is nobody due on the tick that
    # triggers it — and it means a slow or wedged search backend can never
    # delay somebody's agent starting.
    run_harvest(now)
    return n


def serve(poll_sec: int = POLL_SEC):
    log.info(
        "sweep loop: poll %ds, window %02d:00-%02d:00 IST",
        poll_sec, SWEEP_HOUR_START, SWEEP_HOUR_END,
    )
    while True:
        try:
            n = tick()
            if n:
                log.info("swept %d user(s)", n)
        except Exception as e:  # noqa: BLE001
            log.error("sweep tick failed: %s", e)
        time.sleep(poll_sec)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serve", action="store_true", help="run the sweep loop forever")
    ap.add_argument("--once", action="store_true", help="sweep once and exit")
    ap.add_argument("--poll", type=int, default=POLL_SEC)
    args = ap.parse_args()

    if args.once:
        log.info("swept %d user(s)", tick())
    elif args.serve:
        serve(args.poll)
    else:
        for uid in due_users():
            log.info("due now: %s", uid)


if __name__ == "__main__":
    main()
