"""Classify real listings by the DOOR they put in front of an application.

The product's whole promise — "you do nothing, N applications a day" — is only
deliverable on doors that accept an application from a stranger. So the useful
question is not "which sites do we support" but "what does this listing demand
before it will take an application", and how much of the market is behind each
kind of door.

Four classes, in descending order of how well they serve the promise:

  OPEN_EMAIL   a hiring mailbox in the posting. No account, no captcha, and it
               can be sent from the user's OWN mail account, so it carries no
               shared-IP risk and costs no browser time at all.
  OPEN_FORM    a Google Form / public form. No account, rarely a captcha.
  OPEN_ATS     an employer ATS page whose form we can fill AND whose submit is
               not captcha-guarded.
  GUARDED_ATS  same, but a live captcha stands in front of submit. Measured
               reality on Workable and Greenhouse; we do not solve these.
  ACCOUNT      the listing lives on a board that holds the candidate's login
               (Internshala et al). Works, but only for a connected user and
               only from an IP that board is willing to accept.

Reads the `jobs` table — the pool that has actually accumulated — rather than a
fresh crawl, so the answer describes the supply the product really has.

Usage:
    python agent/door_probe.py --sample 40
    python agent/door_probe.py --sample 40 --json out.json

Read-only. Opens pages, never submits, never writes a row.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import db
import hosts
import resolver
import websource

# A mailbox that is plausibly "send your application here". Deliberately narrow:
# a support@ or privacy@ address in a page footer is not an application route,
# and counting it would inflate the one number this probe exists to establish.
_HIRING_MAILBOX = re.compile(
    r"\b([A-Za-z0-9._%+-]*(?:career|job|hiring|recruit|hr|intern|talent|apply|resume|cv)"
    r"[A-Za-z0-9._%+-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b",
    re.I,
)
_FORM_HOST = re.compile(r"(docs\.google\.com/forms|forms\.gle|typeform\.com|airtable\.com/shr)", re.I)


def _sample(limit: int) -> list[dict]:
    with db.conn() as c:
        rows = c.execute(
            "SELECT source, title, company, url, skills FROM jobs "
            "ORDER BY scraped_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    return [dict(r) for r in rows]


def classify(job: dict) -> tuple[str, str]:
    """(door class, evidence). Never raises."""
    url = job.get("url") or ""

    # 1. Board that holds the candidate's account — decided by the source, not
    #    by the page, because that is what actually gates the submit.
    if (job.get("source") or "") not in ("websource", "atsboards"):
        return "ACCOUNT", f"{job.get('source')} holds the candidate's login"

    if _FORM_HOST.search(url):
        return "OPEN_FORM", "public form host"

    # 2. Read the posting once and look for the two open doors.
    try:
        jd = websource.scrape_jd(url) or ""
    except Exception:  # noqa: BLE001
        jd = ""
    mailbox = _HIRING_MAILBOX.search(jd)
    if mailbox:
        return "OPEN_EMAIL", mailbox.group(1)
    if _FORM_HOST.search(jd):
        return "OPEN_FORM", "form link in the posting"

    vendor = hosts.vendor_of(url) or ""
    if vendor:
        return "ATS", f"{vendor} (captcha unknown without opening the form)"
    return "UNKNOWN", "no recognised apply route"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sample", type=int, default=40)
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    jobs = _sample(args.sample)
    print(f"[door] classifying {len(jobs)} listing(s) from the pool\n")

    counts: collections.Counter[str] = collections.Counter()
    rows = []
    for i, job in enumerate(jobs, start=1):
        door, why = classify(job)
        counts[door] += 1
        rows.append({"door": door, "why": why, "title": job.get("title"),
                     "company": job.get("company"), "source": job.get("source"),
                     "url": job.get("url")})
        if i % 10 == 0:
            print(f"[door] {i}/{len(jobs)}")

    total = max(1, len(jobs))
    print("\n=== DOORS ===")
    for door, n in counts.most_common():
        print(f"  {door:<12} {n:>4}  {100 * n / total:5.1f}%")

    hands_off = sum(counts[d] for d in ("OPEN_EMAIL", "OPEN_FORM"))
    print(f"\n  fully hands-off, no account and no captcha : "
          f"{hands_off} ({100 * hands_off / total:.1f}%)")
    print(f"  needs the candidate's own account          : "
          f"{counts['ACCOUNT']} ({100 * counts['ACCOUNT'] / total:.1f}%)")

    if counts["OPEN_EMAIL"]:
        print("\n  sample hiring mailboxes:")
        for r in [r for r in rows if r["door"] == "OPEN_EMAIL"][:8]:
            print(f"    {r['why'][:44]:<44} {str(r['company'])[:26]}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump({"counts": dict(counts), "rows": rows}, f, indent=2)
        print(f"\n[door] written to {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
