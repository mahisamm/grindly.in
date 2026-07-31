"""Grow the index of employer job boards, once for the whole fleet.

`atsboards` can only see the boards it is pointed at. It learns opportunistically
— any ATS URL that happens to turn up in a search result or an application row
becomes a board it polls from then on — which is why the list grew from 380 to
451 in two days without anyone editing it. That is real, and it is also passive:
it learns only what a USER's discovery run happened to trip over.

This is the deliberate version. It runs once a day for the whole fleet, not per
user, because a board is not personal — 1,000 users searching for the same
Bangalore startups is 1,000× the traffic for the same answer.

Two things measured before this was written (agent/supply_probe.py), both of
which decide its shape:

  * **Guessing slugs from company names does not work.** 400 guessed boards
    yielded 9 with any job on them and 2 matchable internships — a 2% hit rate,
    because a board's slug is not the company's name (`caterpillar.keka.com` is
    Group Bayport). Search-harvested boards yielded 27× more per board tested.
    So this harvests by search, and never by guessing.

  * **Keka is where India's internships are.** In a live sweep Greenhouse
    returned 0 India internships across 563 postings while Keka returned 10 from
    391. The global ATSs host foreign companies whose India offices rarely post
    interns publicly. So Keka gets the full city grid and the rest get a short
    one — the query budget follows the measured yield, not the brand.

Every candidate is VALIDATED before it is remembered: a board that 404s or
carries no postings costs one request on every future discovery run forever, so
the cheap check now is worth far more than the slug.

Usage:
    python agent/harvester.py --once          # one sweep, print what it learned
    python agent/harvester.py --once --dry-run
"""
from __future__ import annotations

import argparse
import concurrent.futures
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import atsboards

log = logging.getLogger("grindly.harvester")

# Where each vendor's boards live, and how much query budget it earns.
# `wide` vendors get the full city grid; the rest get the first few. Set from
# measured internship yield — see the module docstring.
_VENDOR_HOSTS: dict[str, tuple[str, bool]] = {
    "keka": ("keka.com/careers", True),
    "workable": ("apply.workable.com", True),
    "greenhouse": ("boards.greenhouse.io", False),
    "lever": ("jobs.lever.co", False),
    "ashby": ("jobs.ashbyhq.com", False),
    "smartrecruiters": ("jobs.smartrecruiters.com", False),
}

_ROLES = [
    "intern", "internship", "trainee", "graduate engineer",
    "software intern", "data intern", "engineering intern",
]
_CITIES = [
    "india", "bangalore", "hyderabad", "pune", "chennai", "mumbai",
    "delhi", "noida", "gurgaon", "ahmedabad", "kolkata", "remote india",
]
_NARROW_CITIES = 3

# How many searches one sweep may issue. SearXNG fronts real engines and this
# server has exactly one IP: a sweep that gets it rate-limited takes the only
# working discovery path down with it, which is a far worse outcome than a
# smaller harvest.
MAX_QUERIES = int(os.environ.get("GRINDLY_HARVEST_MAX_QUERIES", "240"))
SEARCH_WORKERS = int(os.environ.get("GRINDLY_HARVEST_SEARCH_WORKERS", "4"))
# 3, not 8. A board's payload is the company's entire careers site — measured,
# 20 of them exceed 2 MB apiece — and validation holds one per worker in
# memory at once. This runs in the sweep container, which idles at 213 MB
# because of its imports alone, on a 1 vCPU / 3.8 GB box shared with a headed
# Chromium. Eight concurrent multi-megabyte payloads is how the scheduler that
# enqueues everybody's agent gets OOM-killed. Validation is a once-a-day job
# with no user waiting on it, so trading wall-clock for headroom is free.
VALIDATE_WORKERS = int(os.environ.get("GRINDLY_HARVEST_VALIDATE_WORKERS", "3"))


def queries() -> list[str]:
    """The site-scoped searches this sweep will issue, budget-capped."""
    out: list[str] = []
    for vendor, (host, wide) in _VENDOR_HOSTS.items():
        grid = _CITIES if wide else _CITIES[:_NARROW_CITIES]
        for role in _ROLES:
            for city in grid:
                out.append(f"site:{host} {role} {city}")
    return out[:MAX_QUERIES]


def _search_all(qs: list[str]) -> list[str]:
    """Every URL these searches returned. One dead engine never fails a sweep."""
    try:
        import websearch
    except Exception as e:  # noqa: BLE001
        log.warning("no search backend available: %s", e)
        return []

    def _one(q: str) -> list[str]:
        try:
            return [h.get("url") or h.get("link") or ""
                    for h in (websearch.search(q, limit=10) or [])]
        except Exception as e:  # noqa: BLE001
            log.debug("search failed (%s): %s", type(e).__name__, q[:60])
            return []

    urls: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=SEARCH_WORKERS) as ex:
        for found in ex.map(_one, qs):
            urls.extend(u for u in found if u)
    return urls


def candidates(urls) -> list[tuple[str, str]]:
    """(vendor, slug) pairs worth checking — new, plausible, not already known."""
    atsboards._load_learned()
    known = {(v, s.lower()) for v, slugs in atsboards.BOARDS.items() for s in slugs}
    known |= {(v, s.lower()) for v, s in atsboards._LEARNED}

    out: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for vendor, slug in atsboards.slugs_from_urls(urls):
        pair = (vendor, slug)
        if pair in seen or (vendor, slug.lower()) in known:
            continue
        if not atsboards._PLAUSIBLE_SLUG.match(slug):
            continue
        seen.add(pair)
        out.append(pair)
    return out


def validate(pairs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Keep only boards that answer AND carry at least one posting.

    A slug that 404s costs one request on every discovery run from now until
    something notices — and the thing that notices, `atsboards._forget_slug`,
    only runs after the board has already been polled and failed. Checking once
    here is strictly cheaper than learning it the expensive way, and it keeps
    the poll list honest enough that adaptive polling has something to rank.

    Deliberately NOT filtered on "has an internship today": a company that
    hires interns in September has no internship in July, and dropping it now
    means never seeing September's.
    """
    def _one(pair: tuple[str, str]):
        vendor, slug = pair
        payload = postings = None
        try:
            payload = (atsboards._keka_board(slug) if vendor == "keka"
                       else atsboards._get_json(atsboards._API[vendor].format(slug=slug)))
            if not payload:
                return None
            postings = atsboards._postings(vendor, payload, slug)
            return pair if postings else None
        except Exception:  # noqa: BLE001
            return None
        finally:
            # Drop both references before this worker picks up the next board.
            # Without it a thread keeps its last (possibly multi-megabyte)
            # payload alive for the whole map, so peak memory is
            # workers x largest-board rather than workers x current-board.
            del payload, postings

    if not pairs:
        return []
    with concurrent.futures.ThreadPoolExecutor(max_workers=VALIDATE_WORKERS) as ex:
        return [p for p in ex.map(_one, pairs) if p]


def sweep(dry_run: bool = False) -> dict:
    """One harvest: search, extract, validate, remember. Never raises."""
    started = time.time()
    qs = queries()
    urls = _search_all(qs)
    found = candidates(urls)
    good = validate(found)

    learned = 0
    if good and not dry_run:
        # remember_slugs takes URLs, not pairs, and re-derives the slug — so
        # hand it a synthetic URL per vendor rather than reaching into the set
        # directly. Keeps this module out of atsboards' persistence internals.
        learned = atsboards.remember_slugs([_url_for(v, s) for v, s in good])

    result = {
        "queries": len(qs),
        "urls": len(urls),
        "candidates": len(found),
        "validated": len(good),
        "learned": learned,
        "known_after": len(atsboards._LEARNED),
        "elapsed_sec": round(time.time() - started, 1),
        "dry_run": dry_run,
    }
    log.info(
        "harvest: %d quer(ies) -> %d url(s) -> %d new candidate(s) -> "
        "%d live board(s) -> %d learned (%d known) in %ss",
        result["queries"], result["urls"], result["candidates"],
        result["validated"], result["learned"], result["known_after"],
        result["elapsed_sec"],
    )
    return result


def _url_for(vendor: str, slug: str) -> str:
    """A canonical board URL for this (vendor, slug), for remember_slugs.

    Must round-trip through atsboards.slugs_from_urls — a URL shape that its
    patterns do not recognise would silently learn nothing at all.
    """
    return {
        "greenhouse": f"https://boards.greenhouse.io/{slug}",
        "lever": f"https://jobs.lever.co/{slug}",
        "ashby": f"https://jobs.ashbyhq.com/{slug}",
        "workable": f"https://apply.workable.com/{slug}/",
        "smartrecruiters": f"https://jobs.smartrecruiters.com/{slug}",
        "keka": f"https://{slug}.keka.com/careers/",
    }.get(vendor, "")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s")
    ap = argparse.ArgumentParser(description="Grow the employer board index.")
    ap.add_argument("--once", action="store_true", help="one sweep and exit")
    ap.add_argument("--dry-run", action="store_true",
                    help="find and validate, but never write to the index")
    args = ap.parse_args()

    result = sweep(dry_run=args.dry_run)
    print("\n=== HARVEST ===")
    for k, v in result.items():
        print(f"  {k:<14}: {v}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
