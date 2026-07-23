"""Routing coverage readout — the number the auto-apply rollout turns on.

One question, from real traffic rather than an estimate: of the internships the
agent actually discovers, what share have an employer-side intake it can submit
to unattended (Google Form, HR mailbox, ATS portal), versus how many exist only
on a board that holds the user's account?

That ratio decides where the next block of work goes. High, and hands-off
applying is mostly a matter of building the remaining channel adapters. Low, and
the fix is not more automation against the boards — it is more Tier A *sourcing*
(ingesting Greenhouse/Lever/Ashby boards directly, where every listing is Tier A
by construction).

Run it after a week of shadow mode:

    python agent/coverage_report.py                 # whole fleet, all time
    python agent/coverage_report.py --days 7        # last 7 days
    python agent/coverage_report.py --user <uid>    # one user
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

import db
import resolver
import safety


def main() -> int:
    ap = argparse.ArgumentParser(description="Grindly routing coverage")
    ap.add_argument("--user", default=None, help="limit to one user id")
    ap.add_argument("--days", type=int, default=0, help="limit to the last N days")
    args = ap.parse_args()

    since_ms = args.days * 24 * 60 * 60 * 1000 if args.days > 0 else None
    rows = db.destination_coverage(args.user, since_ms)

    if not rows:
        print("No routed applications recorded yet.")
        print(f"Auto-apply mode: {safety.auto_apply_mode()}")
        print("Run the agent at least once with routing enabled, then re-run this.")
        return 0

    total = sum(r["count"] for r in rows)
    employer = sum(
        r["count"] for r in rows if r["channel"] != resolver.CHANNEL_PLATFORM
    )
    scope = args.user or "all users"
    window = f"last {args.days}d" if args.days else "all time"

    print(f"Routing coverage — {scope}, {window}")
    print(f"Auto-apply mode: {safety.auto_apply_mode()}")
    print()
    print(f"{'channel':<16}{'tier':<8}{'count':>8}{'share':>9}")
    print("-" * 41)
    for r in rows:
        share = 100 * r["count"] / total
        print(f"{r['channel']:<16}{r['tier'] or '-':<8}{r['count']:>8}{share:>8.1f}%")
    print("-" * 41)
    print(f"{'TOTAL':<24}{total:>8}")
    print()
    print(
        f"Hands-off capable: {employer}/{total} "
        f"({100 * employer / total:.1f}%) — an employer intake with no user account at stake."
    )
    print(
        f"Needs the user:    {total - employer}/{total} "
        f"({100 * (total - employer) / total:.1f}%) — board-only listings."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
