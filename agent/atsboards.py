"""Discovery straight from employers' ATS boards — no search engine involved.

`websource` finds the same kind of listing by searching the open web, and that
is the right idea with one fatal dependency: it needs a search engine that
answers. Measured on the production VPS, every general engine SearXNG fronts is
blocked from a datacenter IP — DuckDuckGo and Startpage serve a CAPTCHA, Brave
and Google CSE answer "too many requests", Mojeek denies access outright, and
the one engine that does reply (Bing) silently ignores `site:` operators, so
every ATS-scoped query comes back empty. Employer-hosted discovery was running
on nothing but its own disk cache.

Greenhouse, Lever and Ashby each publish every posting on a board through a
public JSON API — the same APIs `websource.scrape_jd` already reads one posting
at a time. Asking those APIs directly needs no engine, no key and no quota, and
returns the full description in the same response. What it needs instead is a
list of companies, which is the honest trade: this source sees exactly the
boards it is pointed at, and nothing else.

Every posting here is on the employer's own ATS, where the candidate holds no
account — resolver grades those TIER_A, the one tier the agent may submit on its
own. Same `fetch(keywords, limit, uid) -> [job dict]` contract as every other
source, so worker.py treats it as one more adapter.
"""
from __future__ import annotations
import concurrent.futures
import hashlib
import html
import json
import os
import re
import time
import urllib.request

import websource

SOURCE = "atsboards"

TIMEOUT = int(os.environ.get("GRINDLY_ATS_BOARD_TIMEOUT", "20"))

# Company slugs, per vendor. Every one was verified live against its API before
# being written down: a slug that 404s costs a request and yields nothing, and a
# typo here is invisible in the logs of a source that is *expected* to return
# nothing for most boards on most days.
#
# This list is the source's entire field of view, so it is meant to grow. New
# slugs also arrive on their own — `_slugs_seen_before` reads back any ATS URL
# the rest of the system has already discovered, so anything websource finds on
# a good day is queried directly from then on.
BOARDS: dict[str, list[str]] = {
    "greenhouse": [
        "devrev", "cloudsek", "enterpret", "olivai", "gravitonresearchcapital",
        "zenoti", "singlestore", "workato", "dept", "thetradedesk",
        "diligentcorporation", "razorpaysoftwareprivatelimited", "postman",
        "observeai", "phonepe", "groww", "databricks", "stripe", "airbnb",
        "zetaglobal", "hackerrank", "tekion", "glance", "sigmoid", "coinbase",
        "gitlab", "mongodb", "elastic", "figma", "asana",
    ],
    "lever": [
        "levelai", "drivetrain", "stable-money1", "endpointclinical",
        "jobgether", "hermeus", "palantir", "quantco-", "nextgenfed", "plus-2",
        "meesho", "cred",
    ],
    "ashby": [
        "ashby", "ramp", "linear", "vanta", "openai", "atlan", "fleetworks",
        "spotdraft", "composio", "elevenlabs", "cursor", "fireworksai",
        "supabase", "posthog", "langchain", "deel",
    ],
}

# Where the role has to be. Deliberately does NOT include a bare "Remote": most
# of these boards are global, and "Remote" on a US company's posting means
# remote in the US. A missed listing costs one match; an application to a role
# the user cannot legally take costs their credibility with that employer.
_INDIA = re.compile(
    r"\b(india|bengaluru|bangalore|mumbai|delhi|ncr|gurgaon|gurugram|hyderabad|"
    r"pune|chennai|noida|kolkata|ahmedabad|jaipur|chandigarh|kochi|coimbatore|"
    r"indore|remote[, ]+india)\b", re.I,
)

_API = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true",
    "lever": "https://api.lever.co/v0/postings/{slug}?mode=json",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{slug}",
}

_MARKUP = re.compile(r"<[^>]+>")


# ---- board cache ------------------------------------------------------------
#
# A board's openings do not change minute to minute, and this runs per user per
# sweep: without a cache, six users cost six identical passes over every board
# in the list. Shared on the data volume so it also survives the deploy restart
# that would otherwise throw the whole thing away.

CACHE_TTL = int(os.environ.get("GRINDLY_ATS_BOARD_CACHE_TTL", "21600"))  # 6h
_CACHE_FILE = os.path.join(
    os.environ.get("GRINDLY_DATA_DIR")
    or os.path.join(os.path.dirname(__file__), "..", "data"),
    "ats_boards.json",
)
_CACHE: dict[str, tuple[float, object]] = {}
_loaded = False


def _load_cache() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True  # set first: a broken file must not be retried per board
    try:
        with open(_CACHE_FILE, encoding="utf-8") as f:
            raw = json.load(f)
        now = time.time()
        for key, (ts, payload) in (raw or {}).items():
            if now - ts <= CACHE_TTL and payload:
                _CACHE[key] = (ts, payload)
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001 — a corrupt cache is not worth a failed run
        print(f"[atsboards] cache load skipped: {type(e).__name__}")


def _save_cache() -> None:
    try:
        os.makedirs(os.path.dirname(_CACHE_FILE), exist_ok=True)
        tmp = _CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({k: [ts, p] for k, (ts, p) in _CACHE.items()}, f)
        os.replace(tmp, _CACHE_FILE)  # atomic: a half-written cache is a corrupt one
    except Exception as e:  # noqa: BLE001
        print(f"[atsboards] cache save skipped: {type(e).__name__}")


def _get_json(url: str):
    try:
        req = urllib.request.Request(
            url, headers={"User-Agent": "Grindly/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 — one dead board never fails the sweep
        print(f"[atsboards] {type(e).__name__} for {url[:70]}")
        return None


def _board(vendor: str, slug: str):
    """One board's postings, from cache when it is fresh."""
    key = f"{vendor}::{slug}"
    _load_cache()
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] <= CACHE_TTL:
        return hit[1]
    payload = _get_json(_API[vendor].format(slug=slug))
    if payload:
        _CACHE[key] = (time.time(), payload)
    return payload


# ---- one shape out of three ------------------------------------------------


def _text(*parts: str) -> str:
    joined = " ".join(p for p in parts if p)
    return re.sub(r"\s+", " ", _MARKUP.sub(" ", html.unescape(joined))).strip()[:6000]


def _place(value) -> str:
    """A location out of whatever the board put there.

    Greenhouse documents an object and Ashby a string, and a board that returns
    the other one must cost that listing, not the run: `.get("name")` on a str
    raises, and the exception escapes the thread pool and empties the whole
    sweep."""
    if isinstance(value, dict):
        return str(value.get("name") or "")
    return str(value or "")


def _greenhouse_url(slug: str, job: dict) -> str:
    """The posting's canonical address on the ATS itself.

    Kept only when the company publishes elsewhere: if `absolute_url` is already
    a greenhouse host, that is the address the employer advertises and it stays.
    """
    job_id = str(job.get("id") or "").strip()
    absolute = job.get("absolute_url") or ""
    if not job_id or not slug:
        return ""
    if "greenhouse.io" in absolute:
        return absolute
    return f"https://boards.greenhouse.io/{slug}/jobs/{job_id}"


def _postings(vendor: str, payload, slug: str = "") -> list[dict]:
    """Normalise a vendor's payload to {title, location, url, jd}."""
    out: list[dict] = []
    if vendor == "greenhouse":
        for j in (payload or {}).get("jobs") or []:
            out.append({
                "title": j.get("title") or "",
                "location": _place(j.get("location")),
                # `absolute_url` is wherever the company chose to publish — for
                # Stripe that is stripe.com/jobs/listing/..., their own careers
                # page. Employer-owned, but nothing downstream can tell it holds
                # an application form without fetching it, so it resolved to the
                # platform channel and TIER_C: never sent. The board's canonical
                # URL is the same posting on the ATS, where the tier is provable.
                "url": _greenhouse_url(slug, j) or (j.get("absolute_url") or ""),
                "jd": _text(j.get("content") or ""),
            })
    elif vendor == "lever":
        for j in payload or []:
            cats = j.get("categories") or {}
            out.append({
                "title": j.get("text") or "",
                "location": _place(cats.get("location")),
                "url": j.get("hostedUrl") or j.get("applyUrl") or "",
                "jd": _text(
                    j.get("descriptionPlain") or j.get("description") or "",
                    *[b.get("text") or "" for b in (j.get("lists") or [])],
                    *[b.get("content") or "" for b in (j.get("lists") or [])],
                ),
            })
    elif vendor == "ashby":
        for j in (payload or {}).get("jobs") or []:
            out.append({
                "title": j.get("title") or "",
                "location": _place(j.get("location")),
                "url": j.get("jobUrl") or j.get("applyUrl") or "",
                "jd": _text(j.get("descriptionPlain") or j.get("descriptionHtml") or ""),
            })
    return [p for p in out if p["url"]]


def _wanted(p: dict) -> bool:
    """An internship, in India, not from an archived year.

    The intern test is `websource`'s, so the two sources cannot drift into
    different opinions about what an internship is — and it is a word-boundary
    match, because a substring test files "Head of SOX and Internal Controls"
    as an internship.
    """
    if not websource.says_internship(p["title"]):
        return False
    if not _INDIA.search(p["location"] or ""):
        return False
    blob = f"{p['title']} {p['jd'][:600]}".lower()
    return not (any(y in blob for y in websource._STALE_WORDS) and "2026" not in blob)


def _relevance(p: dict, keywords: list[str]) -> int:
    """How well this posting answers what the caller asked for.

    Only an ordering, never a filter: matcher.py scores every survivor against
    the user's actual resume, and dropping a posting here on a keyword the user
    never typed would hide roles they would have wanted.
    """
    if not keywords:
        return 0
    blob = f"{p['title']} {p['jd'][:1500]}".lower()
    return sum(1 for k in keywords if k and k.lower().strip() in blob)


def fetch(keywords: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    """Internships posted on employers' own ATS boards. Never raises."""
    targets = [(v, s) for v, slugs in BOARDS.items() for s in sorted(set(slugs))]
    for vendor, slug in _slugs_seen_before():
        if (vendor, slug) not in targets:
            targets.append((vendor, slug))

    found: list[tuple[int, dict]] = []
    seen: set[str] = set()
    # Modest fan-out: these are three companies' APIs, not a search engine, and
    # a burst that gets this server's IP throttled would take the one working
    # discovery path down with it.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(_board, v, s): (v, s) for v, s in targets}
        for fut in concurrent.futures.as_completed(futures):
            vendor, slug = futures[fut]
            try:
                payload = fut.result()
            except Exception as e:  # noqa: BLE001
                print(f"[atsboards] {slug} failed: {type(e).__name__}")
                continue
            try:
                postings = _postings(vendor, payload, slug)
            except Exception as e:  # noqa: BLE001 — a board that changed shape
                print(f"[atsboards] unreadable payload from {slug}: {type(e).__name__}")
                continue
            for p in postings:
                if p["url"] in seen or not _wanted(p):
                    continue
                seen.add(p["url"])
                jd = p["jd"]
                found.append((_relevance(p, keywords or []), {
                    "external_id": hashlib.sha1(p["url"].encode()).hexdigest()[:16],
                    "title": websource._clean_title(p["title"]),
                    "company": websource._company_from(p["title"], p["url"]),
                    "location": p["location"][:80],
                    "stipend": "",
                    "duration": "",
                    "skills": websource._infer_skills(f"{p['title']} {jd}"),
                    "url": p["url"],
                    "jd_text": jd,
                    "source": SOURCE,
                }))
    _save_cache()

    found.sort(key=lambda pair: -pair[0])
    jobs = [j for _, j in found[: max(1, limit)]]
    print(f"[atsboards] {len(jobs)} employer-hosted internship(s) from "
          f"{len(targets)} board(s)")
    return jobs


def _slugs_seen_before() -> list[tuple[str, str]]:
    """Boards the rest of the system has already discovered.

    Discovery that only ever looks at a hardcoded list can never learn. Any ATS
    URL websource surfaced on a day the search engines answered names a company
    worth asking directly from then on — which is how this source stays useful
    without anyone editing BOARDS.
    """
    try:
        import db  # local: agent modules import db lazily, tests run without one

        urls = db.known_ats_urls()
    except Exception:  # noqa: BLE001 — no database is not a reason to discover nothing
        return []
    out: set[tuple[str, str]] = set()
    for url in urls or []:
        for vendor, pattern in (
            ("greenhouse", r"greenhouse\.io/(?:embed/job_board\?for=)?([^/?#]+)"),
            ("lever", r"lever\.co/([^/?#]+)"),
            ("ashby", r"ashbyhq\.com/([^/?#]+)"),
        ):
            m = re.search(pattern, url or "", re.I)
            if m and m.group(1).lower() not in ("embed", "jobs"):
                out.add((vendor, m.group(1)))
    return sorted(out)


def close(uid: str = "") -> None:
    """No browser context to release — kept so worker.py can call close() on
    every source without special-casing this one."""
    return None
