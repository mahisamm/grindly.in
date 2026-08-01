"""Enumerate the employers hosted on a multi-tenant ATS, from a public web index.

The supply problem in one line: every Indian employer that hires interns through
Keka has a careers page at `<company>.keka.com/careers/`, and there is no list of
who those companies are. The board poller can read any tenant it is pointed at;
it just has no way to learn that `convertcart` exists.

Three ways to find out were tried. Two are dead, and the reasons are worth
keeping, because both look obviously correct until measured:

  Certificate Transparency (crt.sh, certspotter) — DEAD.
      The premise was that every tenant needs a TLS certificate and every
      certificate is published. Keka serves `*.keka.com`, one wildcard covering
      every customer, so individual tenants never appear in a CT log at all.
      Measured: 41 names for keka.com, all of them Keka's own infrastructure
      (help., apidocs., academy.). Three tenants taken from our OWN production
      pool — comprinno, ketto, evolve — are absent from CT entirely.

  DNS enumeration — DEAD, and worse than useless.
      `*.keka.com` is a DNS wildcard. `zzzznotarealtenant12345.keka.com`
      resolves, to the same address as a real tenant. So a lookup cannot tell a
      customer from a typo, and a dictionary sweep would "find" every word in
      the dictionary.

  A public web index (Common Crawl) — WORKS.
      Common Crawl publishes a queryable URL index of its crawls, ~126 of them
      going back years. Asking it for `*.keka.com/careers*` returns the careers
      pages it has actually seen, and the hostname of each one IS the tenant.
      Measured: 43 real tenants from a single crawl in 7.4 seconds; 63 across
      four. Every name is a real company — adda247, analyticsvidhya, codingal,
      convertcart — because the index only contains pages that exist.

Why this is the cheapest supply we have
---------------------------------------
Slug guessing was measured at a 2% hit rate, so a thousand real boards costs
fifty thousand requests to somebody else's servers. Here, one request to a
public archive returns hundreds of confirmed-real tenants, and no employer is
touched at all — the crawling was done by someone else, years ago, and we are
reading their notes.

What this deliberately does NOT do
----------------------------------
It does not decide whether a tenant is worth polling. A hostname in an archive
is evidence the company once had a careers page, not that they are hiring today.
That judgement belongs to atsboards._poll_due, which already spends the request
budget on boards that have produced an internship and backs off ones that never
have. This module's whole job is to widen the candidate list; the existing cold
backoff is what stops that from costing anything.

Usage:
    python agent/tenants.py --vendor keka --crawls 8
    python agent/tenants.py --all --crawls 6 --learn
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

_COLLINFO = "http://index.commoncrawl.org/collinfo.json"
_INDEX = "http://index.commoncrawl.org/{crawl}-index"

# The URL shape that identifies a careers page for each vendor, and how to get
# the tenant back out of the hostname.
#
# The path fragment matters as much as the host: `*.keka.com/*` would return
# every login page, help article and asset URL the crawler ever saw, which is
# both far more rows and no more tenants.
_PATTERNS: dict[str, str] = {
    "keka": "*.keka.com/careers*",
    "greenhouse": "boards.greenhouse.io/*",
    "lever": "jobs.lever.co/*",
    "ashby": "jobs.ashbyhq.com/*",
    "smartrecruiters": "careers.smartrecruiters.com/*",
    "workable": "apply.workable.com/*",
}

# For the vendors whose tenant is a PATH segment rather than a subdomain.
_PATH_TENANT = {"greenhouse", "lever", "ashby", "smartrecruiters", "workable"}

# Hostnames under the vendor's domain that are the vendor's own, not a customer.
# Without this, `help`, `www` and `apidocs` get polled as if they were employers
# — a guaranteed 404 per board per run, forever.
_NOT_A_TENANT = {
    "www", "help", "support", "docs", "apidocs", "developers", "api", "app",
    "apps", "blog", "academy", "explore", "go", "kafe", "diagnose", "status",
    "cdn", "static", "assets", "media", "images", "mail", "login", "auth",
    "admin", "demo", "test", "staging", "dev", "sandbox", "a", "m", "id",
    "careers", "jobs", "job", "boards", "apply", "my", "portal", "partner",
    "partners", "community", "events", "webinar", "resources", "pricing",
}

# A tenant slug is one hostname label or one path segment. Anything with an
# escape sequence or punctuation beyond -_. came out of a mis-parse.
_PLAUSIBLE = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$")

_UA = "grindly-tenant-enumerator (+https://grindly.in)"


def _get(url: str, timeout: int = 90) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def crawls(limit: int = 8) -> list[str]:
    """The most recent Common Crawl index ids, newest first.

    Newest first because a tenant that appears only in a 2019 crawl is more
    likely to have churned off the platform, and the request budget is better
    spent where the hit rate is higher.
    """
    try:
        data = json.loads(_get(_COLLINFO, timeout=60))
    except Exception as e:  # noqa: BLE001
        print(f"[tenants] could not list crawls: {type(e).__name__}: {e}")
        return []
    return [c["id"] for c in data[: max(1, limit)] if c.get("id")]


def _tenant_of(url: str, vendor: str) -> str | None:
    """The employer slug inside one indexed URL, or None if it is not one."""
    try:
        parts = urllib.parse.urlsplit(url if "//" in url else f"//{url}")
    except Exception:  # noqa: BLE001
        return None
    host = (parts.netloc or "").lower().split(":")[0]
    if vendor in _PATH_TENANT:
        seg = [s for s in (parts.path or "").split("/") if s]
        if not seg:
            return None
        slug = seg[0]
    else:
        label = host.split(".")[0]
        if not label:
            return None
        slug = label
    if slug.lower() in _NOT_A_TENANT or not _PLAUSIBLE.match(slug):
        return None
    return slug


# A gateway error from the index is a TRANSPORT failure, not an empty answer,
# and treating the two alike is how a sweep silently under-reports. Measured
# over ten crawls in one run: three answered and seven returned 502/504, so
# without retry the yield was capped at a third of what was there.
_RETRY_STATUS = (429, 500, 502, 503, 504)


def from_crawl(vendor: str, crawl: str, limit: int = 5000,
               attempts: int = 4) -> set[str]:
    """Tenants of `vendor` visible in one Common Crawl index. Never raises.

    Retries on a gateway error, shrinking the page size as it goes. The index is
    a free public service and a 504 usually means this particular query was too
    big for it right now rather than that it is down — a smaller `limit` often
    answers immediately where the large one timed out.
    """
    pattern = _PATTERNS.get(vendor)
    if not pattern:
        return set()

    raw = ""
    size = int(limit)
    for attempt in range(max(1, attempts)):
        url = (f"{_INDEX.format(crawl=crawl)}?url={urllib.parse.quote(pattern)}"
               f"&output=json&limit={size}&fl=url")
        try:
            raw = _get(url)
            break
        except urllib.error.HTTPError as e:
            # 404 means this crawl genuinely has no rows for the pattern.
            if e.code == 404:
                return set()
            if e.code not in _RETRY_STATUS or attempt == attempts - 1:
                print(f"[tenants] {vendor}/{crawl}: HTTP {e.code} (gave up)")
                return set()
            size = max(500, size // 2)
            time.sleep(2.0 * (2 ** attempt))
        except Exception as e:  # noqa: BLE001
            if attempt == attempts - 1:
                print(f"[tenants] {vendor}/{crawl}: {type(e).__name__} (gave up)")
                return set()
            time.sleep(2.0 * (2 ** attempt))

    found: set[str] = set()
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            u = json.loads(line).get("url", "")
        except Exception:  # noqa: BLE001
            continue
        slug = _tenant_of(u, vendor)
        if slug:
            found.add(slug)
    return found


def discover(vendor: str, n_crawls: int = 6, pause: float = 3.0) -> set[str]:
    """Every tenant of `vendor` this many recent crawls know about."""
    out: set[str] = set()
    for i, crawl in enumerate(crawls(n_crawls)):
        got = from_crawl(vendor, crawl)
        new = got - out
        out |= got
        print(f"[tenants] {vendor:16} {crawl}  +{len(new):<5} (total {len(out)})")
        # Deliberate: the index is free and shared, and hammering it is how a
        # free service stops being available to anyone.
        if i + 1 < n_crawls:
            time.sleep(pause)
    return out


def board_urls(vendor: str, slugs) -> list[str]:
    """Turn slugs into URLs of the shape atsboards.remember_slugs already parses.

    Going through remember_slugs rather than writing the learned-board file
    directly is on purpose: it owns the plausibility check, the size cap and the
    atomic write, and a second writer to that file is how it ends up corrupt.
    """
    tmpl = {
        "keka": "https://{s}.keka.com/careers/",
        "greenhouse": "https://boards.greenhouse.io/{s}",
        "lever": "https://jobs.lever.co/{s}",
        "ashby": "https://jobs.ashbyhq.com/{s}",
        "smartrecruiters": "https://careers.smartrecruiters.com/{s}",
        "workable": "https://apply.workable.com/{s}/",
    }.get(vendor)
    return [tmpl.format(s=s) for s in sorted(slugs)] if tmpl else []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--vendor", default="keka", choices=sorted(_PATTERNS))
    ap.add_argument("--all", action="store_true", help="every supported vendor")
    ap.add_argument("--crawls", type=int, default=6)
    ap.add_argument("--learn", action="store_true",
                    help="hand what is found to atsboards as candidate boards")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    vendors = sorted(_PATTERNS) if args.all else [args.vendor]
    result: dict[str, list[str]] = {}
    for vendor in vendors:
        slugs = discover(vendor, args.crawls)
        result[vendor] = sorted(slugs)
        print(f"[tenants] {vendor}: {len(slugs)} tenant(s)\n")

    total = sum(len(v) for v in result.values())
    print(f"=== {total} tenant(s) across {len(vendors)} vendor(s) ===")

    if args.learn:
        import atsboards
        learned = 0
        for vendor, slugs in result.items():
            learned += atsboards.remember_slugs(board_urls(vendor, slugs))
        print(f"[tenants] {learned} board(s) were new to the index")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"[tenants] written to {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
