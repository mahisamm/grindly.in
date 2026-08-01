"""How many users can this deployment actually serve today?

The one number the business runs on, and the one that used to be guessed at.
"We promise 5 a day" is a claim about supply, and supply is measurable:

    fleet sends per day  =  live listings  x  K

where K is worker.ALLOC_PER_LISTING — how many different users one listing may
be handed to before it is spent. Divide by the plan's daily quota and you have
how many users the pool supports. Nothing here is a projection; every input is
counted from the index.

Why it is a separate readout rather than a line in a log
-------------------------------------------------------
Because the failure it catches is silent. An agent serving 24 users at 5/day out
of a 300-listing pool looks identical, from every dashboard, to one serving
2,400 — right up to the morning the 25th user signs up and starts receiving two
applications a day instead of five. The pool is the constraint, it moves daily,
and nobody notices it moving.

Reported honestly, which means reporting the parts separately:

  total      every listing ever indexed
  live       still open, as far as anyone can tell (see expire_unseen_jobs)
  with_jd    has a description — needed to score a match at all
  routed     has a known apply route — needed to SEND, which is the real
             bottleneck, and the number that is usually far below `live`

Usage:
    python agent/capacity.py
    python agent/capacity.py --json out.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import db  # noqa: E402
import worker  # noqa: E402

# The plans as sold, taken from the one place that decides them rather than
# copied. A second copy of these numbers is how a capacity report keeps quoting
# 5/day confidently for a year after the plan became 8 — the exact silent
# wrongness this module exists to prevent.
#
# Capacity is quoted PER PLAN, not averaged: a pro user costs three times what a
# plus user does, and the pro promise is the one that breaks first.
PLAN_QUOTAS = db.PLAN_CAPS


def _board_pool() -> int:
    """Live Internshala listings — sendable, but only for a connected user."""
    with db.conn() as c:
        row = c.execute(
            "SELECT COUNT(*) AS n FROM jobs "
            "WHERE dead_at IS NULL AND source='internshala'"
        ).fetchone()
    return int(dict(row or {}).get("n") or 0)


def report() -> dict:
    """Capacity, split by what a user has to have done to receive it.

    The split is the whole point, and the first version of this file got it
    wrong by leaving it out. It counted only employer-side routes and reported
    52 users — while ignoring that 62% of the live pool is Internshala, which
    demonstrably sends and is the single largest source of applications.

    But those two halves are not interchangeable, and averaging them would hide
    the thing that actually decides whether the product works:

      employer-side  reachable by ANY user, the moment they finish setup.
                     Nothing to connect, no account at stake. This is the
                     number behind "you do nothing".
      board          Internshala, from the user's own connected account. Real
                     — the only confirmed sends to date came through it — but
                     only for users who completed the connect flow.

    A user who never connects Internshala gets the first number and nothing
    else. That is the honest floor of the promise, so it is reported first.
    """
    stats = db.index_stats()
    k = worker.ALLOC_PER_LISTING

    # Sendable, not merely live. A listing with no known route cannot become an
    # application however good the match is, so counting it as capacity is the
    # exact optimism this readout exists to remove.
    employer = stats["routed"]
    board = _board_pool()

    employer_sends = employer * k
    board_sends = board * k

    def users(sends: int) -> dict:
        return {plan: sends // quota for plan, quota in PLAN_QUOTAS.items()}

    return {
        **stats,
        "k": k,
        "employer_side": employer,
        "board": board,
        "sendable": employer + board,
        "employer_sends_per_day": employer_sends,
        "board_sends_per_day": board_sends,
        "fleet_sends_per_day": employer_sends + board_sends,
        # What a user who connects NOTHING can be served. The floor of the
        # promise, and the one worth watching.
        "users_supported_hands_off": users(employer_sends),
        "users_supported_connected": users(employer_sends + board_sends),
        # What resolving every remaining live listing would buy. The gap between
        # this and the real number is the value of more route passes, stated
        # rather than implied.
        "if_all_live_were_routed": users(stats["live"] * k),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    r = report()
    print("=== THE INDEX ===")
    print(f"  total listings        {r['total']:>7}")
    print(f"  still live            {r['live']:>7}")
    print(f"  with a description    {r['with_jd']:>7}")
    print(f"  employer-side route   {r['employer_side']:>7}   <- any user, nothing to connect")
    print(f"  Internshala           {r['board']:>7}   <- only a CONNECTED user")
    print()
    print(f"=== CAPACITY (K = {r['k']} users per listing) ===")
    print(f"  sends/day, employer-side only {r['employer_sends_per_day']:>7}")
    print(f"  sends/day, + Internshala      {r['fleet_sends_per_day']:>7}")
    print()
    print("                      hands-off   connected   (ceiling)")
    for plan, quota in PLAN_QUOTAS.items():
        print(f"  {plan:<5} ({quota:>2}/day) "
              f"{r['users_supported_hands_off'][plan]:>11}"
              f"{r['users_supported_connected'][plan]:>12}"
              f"{r['if_all_live_were_routed'][plan]:>12}")
    print()
    print("  hands-off = a user who connects nothing at all. The floor of the")
    print("  promise, and the number worth watching.")

    if r["employer_side"] == 0 and r["live"]:
        print("\n  NOTE: no listing has a resolved employer-side route yet, so a user")
        print("  who connects nothing can be served zero applications however large")
        print("  the pool looks. sweep.resolve_routes fills this in once a day.")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(r, f, indent=2)
        print(f"\n[capacity] written to {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
