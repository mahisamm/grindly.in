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


def report() -> dict:
    stats = db.index_stats()
    k = worker.ALLOC_PER_LISTING

    # Sendable, not merely live. A listing with no known route cannot become an
    # application however good the match is, so counting it as capacity is the
    # exact optimism this readout exists to remove.
    sendable = stats["routed"]
    daily_sends = sendable * k

    out = {
        **stats,
        "k": k,
        "sendable": sendable,
        "fleet_sends_per_day": daily_sends,
        "users_supported": {
            plan: daily_sends // quota for plan, quota in PLAN_QUOTAS.items()
        },
    }

    # What the pool would support if every live listing had a route. The gap
    # between this and the real number is the value of resolving routes, stated
    # rather than implied.
    out["if_all_live_were_routed"] = {
        plan: (stats["live"] * k) // quota for plan, quota in PLAN_QUOTAS.items()
    }
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    r = report()
    print("=== THE INDEX ===")
    print(f"  total listings      {r['total']:>7}")
    print(f"  still live          {r['live']:>7}")
    print(f"  with a description  {r['with_jd']:>7}")
    print(f"  with an apply route {r['routed']:>7}   <- the one that can be SENT")
    print()
    print(f"=== CAPACITY (K = {r['k']} users per listing) ===")
    print(f"  fleet sends per day {r['fleet_sends_per_day']:>7}")
    for plan, quota in PLAN_QUOTAS.items():
        n = r["users_supported"][plan]
        ceiling = r["if_all_live_were_routed"][plan]
        print(f"  {plan:<5} ({quota:>2}/day)      {n:>7} users"
              f"   (ceiling if every live listing were routed: {ceiling})")

    if r["routed"] == 0 and r["live"]:
        print("\n  NOTE: nothing in the pool has a resolved apply route yet, so the")
        print("  sendable capacity is zero however large the pool looks. Routes are")
        print("  written by the apply loop as it goes (worker.shared_destination),")
        print("  so this fills in as runs happen rather than all at once.")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(r, f, indent=2)
        print(f"\n[capacity] written to {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
