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


def due_users(now: datetime.datetime | None = None) -> list[str]:
    """Active users whose sweep hour has arrived and who have no live run today."""
    now = now or _ist_now()
    today = now.date().isoformat()
    out: list[str] = []
    for uid in db.active_users():
        if now.hour < sweep_hour(uid, today):
            continue
        if db.has_live_run_today(uid):
            continue
        out.append(uid)
    return out


def tick(now: datetime.datetime | None = None) -> int:
    """Enqueue one live run for every user who is due. Returns how many."""
    n = 0
    for uid in due_users(now):
        try:
            run_queue.enqueue(uid, "live")
            db.add_audit("sweep_enqueued", user_id=uid, detail="daily sweep")
            log.info("enqueued daily run for %s", uid)
            n += 1
        except Exception as e:  # noqa: BLE001
            # One user's failure must not stop the rest of the fleet being swept.
            log.error("could not enqueue %s: %s", uid, e)
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
