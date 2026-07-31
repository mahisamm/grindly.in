"""Measure how much internship supply the open web can actually deliver.

Every plan past this one prices off one number: how many FRESH, MATCHABLE
internships per day a bigger board index would yield. Guessing it is how a
scraping project becomes a scraping habit — so this measures it before
anything is built on top.

Two harvest modes, because the index will use both and they have completely
different economics:

  * `--mode guess`  — take a company name, slugify it, ask each vendor's API
    whether that board exists. Costs one request per (vendor, slug) pair and
    needs no search engine at all. Cheap and rude; the hit rate is the whole
    question.
  * `--mode search` — the existing websearch path, scoped per vendor host.
    Costs a search quota, returns only boards a search engine has indexed.

What it reports, per 1000 boards TESTED (not found — tested, so the number
prices the harvest, not the wish):

    live boards / boards with any India internship / internships / matchable

"Matchable" runs the real matcher against a real profile at the real
threshold, because a listing that scores 40 is not supply — it is noise the
user never sees. Everything before that column is vanity.

Usage:
    python agent/supply_probe.py --mode guess --limit 500 --email you@x.com
    python agent/supply_probe.py --mode search --limit 200 --email you@x.com
    python agent/supply_probe.py --mode both --limit 300 --json out.json

Read-only. Never writes a board to the learned list, never applies to
anything, never touches a user's row.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import atsboards
import db
import matcher
import websource

# Companies to try as slugs. Deliberately Indian-tech-heavy and deliberately
# NOT the ones already in atsboards.BOARDS — the question is what a harvest
# would ADD, so anything already known is filtered out below and does not
# count against the hit rate either way.
#
# This is a seed for measurement, not the eventual index. The real harvester
# (step 4) pulls names from startup directories and funding lists; this list
# exists so the probe can run today without one.
SEED_COMPANIES = [
    # Indian product companies / unicorns / soonicorns
    "zerodha", "razorpay", "zepto", "swiggy", "zomato", "flipkart", "myntra",
    "nykaa", "lenskart", "urbancompany", "dream11", "paytm", "phonepe",
    "policybazaar", "delhivery", "rivigo", "blackbuck", "udaan", "moglix",
    "ninjacart", "licious", "bigbasket", "dunzo", "rapido", "ola", "olacabs",
    "unacademy", "byjus", "vedantu", "toppr", "cuemath", "physicswallah",
    "upgrad", "simplilearn", "scaler", "newton", "codingninjas", "geeksforgeeks",
    "chargebee", "freshworks", "zoho", "browserstack", "postman", "hasura",
    "clevertap", "moengage", "webengage", "netcore", "wingify", "vwo",
    "innovaccer", "practo", "pharmeasy", "1mg", "medibuddy", "curefit",
    "cult", "healthifyme", "wysa", "mfine", "portea",
    "cred", "jupiter", "fi", "epifi", "slice", "uni", "onecard", "navi",
    "khatabook", "okcredit", "bharatpe", "mswipe", "pinelabs", "cashfree",
    "juspay", "signzy", "perfios", "m2p", "zeta", "setu", "decentro",
    "meesho", "shopsy", "citymall", "dealshare", "elasticrun",
    "sharechat", "mohalla", "koo", "josh", "mxtakatak", "chingari",
    "groww", "upstox", "smallcase", "indmoney", "kuvera", "scripbox",
    "wealthy", "tickertape", "streak", "sensibull", "dhan",
    "darwinbox", "keka", "springworks", "peoplestrong", "greytip",
    "leadsquared", "kylas", "salesken", "avoma", "gong",
    "sprinklr", "capillary", "vymo", "eightfold", "hirevue",
    "turing", "andela", "deel", "remote", "multiplier", "skuad",
    "atlan", "whatfix", "chargebee", "gupshup", "exotel", "knowlarity",
    "kaleyra", "route", "plivo", "twilio", "msg91",
    "yellowai", "haptik", "verloop", "ameyo", "ozonetel",
    "mindtickle", "disprz", "edcast", "harbinger",
    "quickheal", "seqrite", "lucideus", "safehats", "appsecco",
    "cloudsek", "traceable", "cloudanix", "astra", "hackerearth",
    "hackerrank", "interviewbit", "codechef", "codeforces",
    "wingman", "clari", "outplay", "klenty", "smartlead",
    "zluri", "spendflo", "recur", "velocity", "getvantage",
    "fampay", "junio", "akudo", "pencilton",
    "furlenco", "rentomojo", "nobroker", "housing", "magicbricks",
    "cars24", "spinny", "droom", "cardekho", "zoomcar", "bounce", "yulu",
    "porter", "shiprocket", "shadowfax", "loadshare", "wefast",
    "zetwerk", "infra", "ofbusiness", "bizongo", "moglilabs",
    "leverageedu", "collegedekho", "shiksha", "careers360",
    "internshala", "cutshort", "instahyre", "wellfound", "angellist",
    "apna", "workindia", "jobhai", "vahan",
    "observeai", "level", "levelai", "rocketlane", "spotdraft",
    "leena", "leenaai", "kore", "koreai", "senseforth",
    "tessell", "yugabyte", "singlestore", "acceldata", "sigmoid",
    "tredence", "mathco", "fractal", "quantiphi", "mu-sigma",
    "latentview", "affine", "absolutdata", "gramener",
    "arcesium", "tower", "graviton", "quadeye", "alphagrep",
    "wintwealth", "stable", "stablemoney", "jar", "gullak",
    "beato", "spinny", "ultrahuman", "noise", "boat", "boult",
    "wakefit", "sleepycat", "duroflex", "pepperfry",
    "mamaearth", "sugar", "plum", "minimalist", "wow",
    "licious", "freshtohome", "countrydelight", "milkbasket",
    "rebel", "eatfit", "boxbeats", "chaayos", "thirdwave",
    "tonbo", "ideaforge", "skyroot", "agnikul", "pixxel", "dhruva",
    "digantara", "bellatrix", "astrogate",
    "ather", "ultraviolette", "revolt", "simpleenergy", "riverindia",
    "euler", "altigreen", "logio", "battery", "log9",
    "cropin", "ninjacart", "waycool", "dehaat", "absolute",
    "stellapps", "intello", "arya", "jai-kisan",
    "khethari", "gramophone", "bijak", "agrostar",
]

VENDORS = ["greenhouse", "lever", "ashby", "workable", "keka", "smartrecruiters"]

# A profile the probe scores against when no real user is named. Deliberately a
# plain CS-undergrad stack: the question "how much supply exists" has a very
# different answer for a niche profile, and the fleet-wide plan should be
# priced against the common case.
DEFAULT_SKILLS = [
    "python", "java", "javascript", "react", "sql", "machine learning",
    "data structures", "git", "html", "css", "node.js",
]
DEFAULT_DOMAINS = ["Web Development", "Machine Learning", "Software Engineering"]
DEFAULT_THRESHOLD = 65


def _slug_variants(name: str) -> list[str]:
    """The handful of spellings a company's board is plausibly registered under.

    Bounded on purpose: every variant is a live request, and the point of the
    guess mode is that it is CHEAP. Three spellings of 200 companies is 600
    requests; ten spellings is 2000 for a yield curve that flattens after the
    first two.
    """
    base = re.sub(r"[^a-z0-9]+", "", (name or "").lower())
    if not base:
        return []
    out = [base]
    hyphen = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    if hyphen != base:
        out.append(hyphen)
    for suffix in ("hq", "inc", "labs", "technologies"):
        if base.endswith(suffix):
            trimmed = base[: -len(suffix)]
            if len(trimmed) >= 3:
                out.append(trimmed)
    return out[:3]


def _known_pairs() -> set[tuple[str, str]]:
    """Boards the system already polls — excluded from the probe entirely.

    Both the hardcoded list and anything learned on disk. A probe that
    "discovers" a board already in the rotation measures nothing.
    """
    known = {(v, s.lower()) for v, slugs in atsboards.BOARDS.items() for s in slugs}
    try:
        atsboards._load_learned()
        known |= {(v, s.lower()) for v, s in atsboards._LEARNED}
    except Exception:  # noqa: BLE001
        pass
    return known


def _probe_board(vendor: str, slug: str) -> dict:
    """Ask one vendor whether this board exists, and what is on it.

    Deliberately calls the vendor API directly rather than atsboards._board:
    that path reads and WRITES the shared cache, and a probe must not poison
    the production cache with 600 misses.
    """
    result = {
        "vendor": vendor, "slug": slug, "live": False,
        "postings": 0, "india_postings": 0, "intern_postings": 0,
        "india_internships": 0, "listings": [],
    }
    try:
        if vendor == "keka":
            payload = atsboards._keka_board(slug)
        else:
            payload = atsboards._get_json(atsboards._API[vendor].format(slug=slug))
    except Exception:  # noqa: BLE001
        return result
    if not payload:
        return result

    try:
        postings = atsboards._postings(vendor, payload, slug)
    except Exception:  # noqa: BLE001
        return result

    result["live"] = True
    result["postings"] = len(postings)
    for p in postings:
        # Which gate each posting dies at, counted separately. "3 internships
        # from 400 boards" is useless on its own: an empty board, a board with
        # no interns, and a board whose interns are all in Berlin need three
        # completely different fixes, and only the counts tell them apart.
        try:
            in_india = bool(atsboards._INDIA.search(p.get("location") or ""))
            is_intern = websource._looks_like_an_internship(
                p.get("title") or "", (p.get("jd") or "")[:600])
        except Exception:  # noqa: BLE001
            continue
        if in_india:
            result["india_postings"] += 1
        if is_intern:
            result["intern_postings"] += 1
        try:
            if not atsboards._wanted(p):
                continue
        except Exception:  # noqa: BLE001
            continue
        result["india_internships"] += 1
        jd = p.get("jd") or ""
        result["listings"].append({
            "title": websource._clean_title(p["title"]),
            "company": p.get("company") or websource._company_from(p["title"], p["url"]),
            "location": (p.get("location") or "")[:80],
            "url": p["url"],
            "skills": websource._infer_skills(f"{p['title']} {jd}"),
            "jd_text": jd,
        })
    return result


def harvest_by_guess(limit: int, workers: int = 12) -> list[tuple[str, str]]:
    """Candidate (vendor, slug) pairs from slugified company names."""
    known = _known_pairs()
    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for name in SEED_COMPANIES:
        for slug in _slug_variants(name):
            for vendor in VENDORS:
                pair = (vendor, slug)
                if pair in seen or (vendor, slug.lower()) in known:
                    continue
                seen.add(pair)
                pairs.append(pair)
                if len(pairs) >= limit:
                    return pairs
    return pairs


def harvest_by_search(limit: int) -> list[tuple[str, str]]:
    """Candidate pairs from search results scoped to each vendor's host.

    Returns the pairs a `site:`-scoped sweep would learn. Measured separately
    from guessing because it costs search quota and is capped by whatever the
    engines will actually answer from this IP.
    """
    try:
        import websearch
    except Exception as e:  # noqa: BLE001
        print(f"[probe] search mode unavailable: {e}")
        return []

    known = _known_pairs()
    # Weighted by measured yield, not by vendor prestige. A 35-board search
    # sweep returned 7 India internships from Keka and ZERO from Greenhouse's
    # 563 postings — the global ATSs host foreign companies whose India
    # offices rarely post interns publicly, while Keka is where an Indian
    # company posts. So Keka gets the city grid and the rest get the short list.
    hosts_by_vendor = {
        "keka": "keka.com/careers",
        "workable": "apply.workable.com",
        "greenhouse": "boards.greenhouse.io",
        "lever": "jobs.lever.co",
        "ashby": "jobs.ashbyhq.com",
        "smartrecruiters": "jobs.smartrecruiters.com",
    }
    roles = ["intern", "internship", "trainee", "graduate engineer",
             "software intern", "data intern"]
    cities = ["india", "bangalore", "hyderabad", "pune", "chennai", "mumbai",
              "delhi", "noida", "gurgaon", "remote india"]
    queries: list[str] = []
    for vendor, host in hosts_by_vendor.items():
        grid = cities if vendor in ("keka", "workable") else cities[:3]
        for role in roles:
            for city in grid:
                queries.append(f"site:{host} {role} {city}")

    urls: list[str] = []
    # Concurrent, but modestly: SearXNG fronts real engines and a burst gets
    # this IP throttled on the one discovery path that works.
    def _one(query: str) -> list[str]:
        try:
            return [h.get("url") or h.get("link") or ""
                    for h in (websearch.search(query, limit=10) or [])]
        except Exception as e:  # noqa: BLE001
            print(f"[probe] search failed: {query[:50]} {type(e).__name__}")
            return []

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        for i, found in enumerate(ex.map(_one, queries), start=1):
            urls.extend(u for u in found if u)
            if i % 50 == 0:
                print(f"[probe] {i}/{len(queries)} queries, {len(urls)} urls")
    print(f"[probe] {len(queries)} queries returned {len(urls)} url(s)")

    pairs: list[tuple[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for vendor, slug in atsboards.slugs_from_urls(urls):
        pair = (vendor, slug)
        if pair in seen or (vendor, slug.lower()) in known:
            continue
        if not atsboards._PLAUSIBLE_SLUG.match(slug):
            continue
        seen.add(pair)
        pairs.append(pair)
        if len(pairs) >= limit:
            break
    return pairs


def run(pairs: list[tuple[str, str]], skills: list[str], domains: list[str],
        threshold: int, workers: int = 12) -> dict:
    """Poll every candidate board and score everything found."""
    tested = len(pairs)
    live = boards_with_jobs = boards_with_supply = 0
    postings = india_postings = intern_postings = 0
    per_vendor: dict[str, dict[str, int]] = {}
    internships: list[dict] = []

    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(_probe_board, v, s) for v, s in pairs]
        for i, fut in enumerate(concurrent.futures.as_completed(futures), start=1):
            try:
                r = fut.result()
            except Exception:  # noqa: BLE001
                continue
            v = per_vendor.setdefault(
                r["vendor"], {"tested": 0, "live": 0, "postings": 0, "internships": 0})
            v["tested"] += 1
            if r["live"]:
                live += 1
                v["live"] += 1
            if r["postings"]:
                boards_with_jobs += 1
            postings += r["postings"]
            v["postings"] += r["postings"]
            india_postings += r["india_postings"]
            intern_postings += r["intern_postings"]
            if r["india_internships"]:
                boards_with_supply += 1
                v["internships"] += r["india_internships"]
                internships.extend(r["listings"])
            if i % 50 == 0:
                print(f"[probe] {i}/{tested} boards tested, "
                      f"{live} live, {len(internships)} internships so far")

    matchable = []
    for job in internships:
        try:
            score, reason = matcher.score_job(
                job, skills, domains, exp_level="intern",
                jd_text=job.get("jd_text") or "",
            )
        except Exception:  # noqa: BLE001
            continue
        job["score"] = score
        job["reason"] = reason
        if score >= threshold:
            matchable.append(job)

    elapsed = round(time.time() - started, 1)
    per_1000 = (lambda n: round(1000 * n / tested, 1) if tested else 0.0)
    return {
        "tested": tested,
        "live_boards": live,
        "boards_with_jobs": boards_with_jobs,
        "boards_with_supply": boards_with_supply,
        "postings": postings,
        "india_postings": india_postings,
        "intern_postings": intern_postings,
        "internships": len(internships),
        "matchable": len(matchable),
        "threshold": threshold,
        "elapsed_sec": elapsed,
        "per_vendor": per_vendor,
        "per_1000_tested": {
            "live_boards": per_1000(live),
            "internships": per_1000(len(internships)),
            "matchable": per_1000(len(matchable)),
        },
        "sample": sorted(
            ({"title": j["title"], "company": j["company"], "score": j["score"],
              "location": j["location"], "url": j["url"]} for j in matchable),
            key=lambda j: j["score"], reverse=True,
        )[:25],
        "new_boards": sorted(
            {(j["company"]) for j in internships}
        )[:50],
    }


def _profile_for(email: str) -> tuple[list[str], list[str]]:
    """A real user's skills+domains when one is named, else the default stack."""
    if not email:
        return DEFAULT_SKILLS, DEFAULT_DOMAINS
    try:
        with db.conn() as c:
            row = c.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if not row:
            print(f"[probe] no user {email}; using the default profile")
            return DEFAULT_SKILLS, DEFAULT_DOMAINS
        user = db.get_user(row["id"]) or {}
        profile = user.get("profile") or {}
        skills = json.loads(profile.get("skills") or "[]")
        domains = json.loads(profile.get("preferred_domains") or "[]")
        if not skills:
            print(f"[probe] {email} has no skills on file; using the default stack")
            return DEFAULT_SKILLS, domains or DEFAULT_DOMAINS
        return skills, domains or DEFAULT_DOMAINS
    except Exception as e:  # noqa: BLE001
        print(f"[probe] could not read {email} ({type(e).__name__}); using defaults")
        return DEFAULT_SKILLS, DEFAULT_DOMAINS


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--mode", choices=["guess", "search", "both"], default="guess")
    ap.add_argument("--limit", type=int, default=500, help="boards to TEST")
    ap.add_argument("--email", default="", help="score against this user's profile")
    ap.add_argument("--threshold", type=int, default=DEFAULT_THRESHOLD)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--json", default="", help="write the full result here")
    args = ap.parse_args()

    skills, domains = _profile_for(args.email)
    print(f"[probe] scoring against {len(skills)} skill(s), domains={domains}, "
          f"threshold={args.threshold}")

    pairs: list[tuple[str, str]] = []
    if args.mode in ("guess", "both"):
        guessed = harvest_by_guess(args.limit)
        print(f"[probe] guess mode: {len(guessed)} candidate board(s)")
        pairs += guessed
    if args.mode in ("search", "both"):
        searched = harvest_by_search(args.limit)
        print(f"[probe] search mode: {len(searched)} candidate board(s)")
        pairs += searched

    if not pairs:
        print("[probe] no candidates to test")
        return 1

    result = run(pairs, skills, domains, args.threshold, workers=args.workers)

    print("\n=== SUPPLY PROBE ===")
    print(f"boards tested        : {result['tested']}")
    print(f"live boards          : {result['live_boards']}")
    print(f"boards with any job  : {result['boards_with_jobs']}")
    print(f"boards with supply   : {result['boards_with_supply']}")
    print(f"total postings       : {result['postings']}")
    print(f"  ...located India   : {result['india_postings']}")
    print(f"  ...an internship   : {result['intern_postings']}")
    print(f"India internships    : {result['internships']}")
    print(f"matchable (>= {result['threshold']})  : {result['matchable']}")
    print(f"elapsed              : {result['elapsed_sec']}s")
    print("\nper vendor (tested/live/postings/internships):")
    for vendor, v in sorted(result["per_vendor"].items()):
        print(f"  {vendor:<16}: {v['tested']:>4} / {v['live']:>4} / "
              f"{v['postings']:>5} / {v['internships']:>3}")
    print("\nper 1000 boards TESTED:")
    for k, v in result["per_1000_tested"].items():
        print(f"  {k:<16}: {v}")
    if result["sample"]:
        print("\ntop matchable:")
        for j in result["sample"][:10]:
            print(f"  {j['score']:>3}  {j['title'][:48]:<48} {j['company'][:22]}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2)
        print(f"\n[probe] full result written to {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
