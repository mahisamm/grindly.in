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
import datetime
import hashlib
import html
import json
import os
import re
import time
import urllib.request

import hosts
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
    # Verified live from the VPS: Bosch alone publishes 21 open India roles
    # through this API, Avery Dennison 10. Same public-JSON deal as the big
    # three, and it reaches large manufacturers and enterprises that never
    # appear on a startup-heavy Greenhouse/Lever list.
    "smartrecruiters": [
        "BoschGroup", "AveryDennison", "WesternDigital", "Visa",
    ],
    # Shape verified live; slugs arrive mostly through _slugs_seen_before, since
    # Workable accounts are named after the company and are exactly what a
    # site:apply.workable.com search returns.
    "workable": [],
}

# Deliberately NOT here: Workday. Measured before adding it — its job search is
# a fuzzy full-text match, so `searchText: "intern"` returns "Senior Platform
# Software Engineer", "Manager, Product Management" and "Analyst, Tax" (all real
# results from nvidia, mastercard and paypal), because it matches "internal" and
# "international" too. Filtering those back out with the same word-boundary test
# every other vendor uses left approximately zero real India internships across
# ten large tenants: the companies on Workday hire interns through campus
# programmes, not their public board. It also costs five paginated POSTs per
# tenant. Cost real, yield nil.

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
    "smartrecruiters": "https://api.smartrecruiters.com/v1/companies/{slug}/postings?limit=100",
    "workable": "https://apply.workable.com/api/v1/widget/accounts/{slug}?details=true",
    # Indian ATS. Everything above it is where a foreign-headquartered company
    # posts; Keka is where an Indian one does, and the whole board list was
    # skewed away from exactly the employers this product exists to reach.
    # Takes a second placeholder — see _keka_board for why the GUID is fetched
    # rather than guessed.
    "keka": "https://{slug}.keka.com/careers/api/embedjobs/default/active/{guid}",
}

# Where a posting's description lives when the list endpoint doesn't carry it.
# SmartRecruiters returns a catalogue without any body text, so the description
# has to be asked for per posting — bounded to the ones that already passed the
# internship and India gates, which is a handful, not the whole board.
_DETAIL_API = {
    "smartrecruiters":
        "https://api.smartrecruiters.com/v1/companies/{slug}/postings/{job_id}",
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


_KEKA_INFO = "https://{slug}.keka.com/careers/api/organization/default/careerportalinfo"
# Keka addresses a board by an opaque per-organisation GUID, not by the
# subdomain — /careers/api/embedjobs/default/active/<guid>. The GUID is not
# published anywhere as a field; it appears inside the asset paths the portal
# hands out ("/ats/documents/<guid>/careerportal/..."), which is a public,
# unauthenticated response and the only place to read it from outside.
_KEKA_GUID = re.compile(r"/ats/documents/([0-9a-f-]{36})/", re.I)


def _keka_board(slug: str):
    """Keka's postings: one call to learn the org GUID, one to use it.

    Cheap enough to do per board — both responses are small and the whole thing
    sits behind the same six-hour cache as every other vendor.
    """
    info = _get_json(_KEKA_INFO.format(slug=slug))
    if not info:
        return None
    found = _KEKA_GUID.search(json.dumps(info))
    if not found:
        print(f"[atsboards] keka/{slug}: no org id in the portal info")
        return None
    return _get_json(_API["keka"].format(slug=slug, guid=found.group(1)))


def _board(vendor: str, slug: str):
    """One board's postings, from cache when it is fresh."""
    key = f"{vendor}::{slug}"
    _load_cache()
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] <= CACHE_TTL:
        return hit[1]
    payload = _keka_board(slug) if vendor == "keka" else _get_json(_API[vendor].format(slug=slug))
    if payload:
        _CACHE[key] = (time.time(), payload)
    elif (vendor, slug) in _LEARNED:
        # A learned board that answers nothing was a guess that did not pay off
        # — a company that closed its board, or a slug read out of a URL that
        # did not contain one. Keeping it costs a request on every future sweep,
        # forever, for a board that has never returned anything. Seeded boards
        # are left alone: those were verified by hand and a miss is transient.
        _forget_slug(vendor, slug)
    return payload


def _forget_slug(vendor: str, slug: str) -> None:
    _LEARNED.discard((vendor, slug))
    try:
        tmp = _LEARNED_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sorted(_LEARNED), f)
        os.replace(tmp, _LEARNED_FILE)
    except Exception:  # noqa: BLE001 — forgetting is housekeeping, never critical
        pass


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


def _age_days(value) -> int | None:
    """How many days ago was this posted? None when the board didn't say.

    Every vendor stamps a date and none of them were read, so a posting from
    2023 ranked exactly like one from this morning — and a stale posting is not
    a neutral result, it is an application that gets no reply and a slot spent.
    Accepts ISO strings (all five vendors) and epoch millis (Workable).
    """
    if value in (None, "", 0):
        return None
    try:
        if isinstance(value, (int, float)) or str(value).isdigit():
            secs = float(value)
            if secs > 1e11:  # milliseconds
                secs /= 1000.0
            when = datetime.datetime.fromtimestamp(secs, datetime.timezone.utc)
        else:
            text = str(value).strip().replace("Z", "+00:00")
            when = datetime.datetime.fromisoformat(text)
            if when.tzinfo is None:
                when = when.replace(tzinfo=datetime.timezone.utc)
    except Exception:  # noqa: BLE001 — an unparseable date is "unknown", not a crash
        return None
    delta = datetime.datetime.now(datetime.timezone.utc) - when
    return max(0, delta.days)


def canonical_key(url: str, vendor: str = "", slug: str = "", job_id: str = "") -> str:
    """One identity per posting, whatever address it arrived at.

    Greenhouse alone publishes the same job on `boards.greenhouse.io`,
    `job-boards.greenhouse.io` and `job-boards.eu.greenhouse.io`; a live run
    returned all three hosts at once and counted them as separate finds. Keying
    on the URL makes one posting look like three — inflating the pipeline with
    duplicates the user then sees three times.
    """
    vendor = vendor or hosts.vendor_of(url)
    if vendor and slug and job_id:
        return f"{vendor}:{slug.lower()}:{job_id}".lower()
    if vendor:
        # Last path segment that looks like an id, else the whole path.
        path = re.sub(r"[?#].*$", "", url or "").rstrip("/")
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2:
            return f"{vendor}:{parts[-2].lower()}:{parts[-1].lower()}"
    return (url or "").strip().lower()


def _still_on_the_ats(url: str) -> bool:
    """Does this posting's own address still serve the posting?

    Some employers wire their ATS board to bounce every posting to their own
    careers site — Stripe's boards.greenhouse.io address 302s to
    stripe.com/jobs/listing/... The posting is real and the API lists it, but
    the page the candidate reaches is a bespoke React application with no form
    this sender can drive, so offering it produces one guaranteed "could not
    find the application form" per listing.

    Checked with a HEAD (a GET only if the host refuses HEAD), and only for the
    handful of postings that advertise an off-vendor address, so the cost is a
    few requests per run rather than one per posting.
    """
    import urllib.error
    import urllib.request

    class _Head(urllib.request.Request):
        def get_method(self) -> str:  # noqa: D401
            return "HEAD"

    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/125"}
    for build in (_Head, urllib.request.Request):
        try:
            with urllib.request.urlopen(build(url, headers=headers), timeout=12) as r:
                return bool(hosts.vendor_of(r.geturl()))
        except urllib.error.HTTPError as e:
            # 4xx/5xx says nothing about ownership; keep the listing and let the
            # sender's own closed/gone checks judge it at submit time.
            return e.code not in (404, 410)
        except Exception:  # noqa: BLE001
            continue
    return True


def _drop_postings_that_leave_the_ats(jobs: list[dict]) -> list[dict]:
    """Remove postings whose ATS address redirects to an employer-run page.

    "Remove what the agent cannot do" — a listing that can only ever come back
    as needs_review is worth less than no listing at all, because it spends a
    daily slot and asks the user to finish it by hand.
    """
    suspects = [j for j in jobs if j.get("offsite_apply")]
    if not suspects:
        return [{k: v for k, v in j.items() if k != "offsite_apply"} for j in jobs]

    verdicts: dict[str, bool] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for j, ok in zip(suspects, ex.map(lambda j: _still_on_the_ats(j["url"]), suspects)):
            verdicts[j["url"]] = ok

    kept: list[dict] = []
    for j in jobs:
        if not verdicts.get(j["url"], True):
            print(f"[atsboards] dropping {j['company']}: its board address leaves "
                  f"the ATS for a page we cannot submit on")
            continue
        kept.append({k: v for k, v in j.items() if k != "offsite_apply"})
    return kept


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
    """Normalise a vendor's payload to {title, location, url, jd, ...}.

    Every posting also carries `job_id`, `posted_days` and `company` where the
    board supplies them — the identity, the age and the employer's real name,
    none of which were read before.
    """
    out: list[dict] = []
    if vendor == "greenhouse":
        for j in (payload or {}).get("jobs") or []:
            out.append({
                "title": j.get("title") or "",
                "job_id": str(j.get("id") or ""),
                "company": (j.get("company_name") or "").strip(),
                "posted_days": _age_days(j.get("updated_at") or j.get("first_published")),
                "location": _place(j.get("location")),
                # `absolute_url` is wherever the company chose to publish — for
                # Stripe that is stripe.com/jobs/listing/..., their own careers
                # page. Employer-owned, but nothing downstream can tell it holds
                # an application form without fetching it, so it resolved to the
                # platform channel and TIER_C: never sent. The board's canonical
                # URL is the same posting on the ATS, where the tier is provable.
                "url": _greenhouse_url(slug, j) or (j.get("absolute_url") or ""),
                # A company that publishes off the ATS may also have wired its
                # board to bounce there, which leaves the sender on a page it
                # cannot drive. Flagged here, verified once at the end of the
                # run — see _drop_postings_that_leave_the_ats.
                "offsite_apply": bool(
                    (j.get("absolute_url") or "")
                    and not hosts.vendor_of(j.get("absolute_url") or "")
                ),
                "jd": _text(j.get("content") or ""),
            })
    elif vendor == "lever":
        for j in payload or []:
            cats = j.get("categories") or {}
            out.append({
                "title": j.get("text") or "",
                "job_id": str(j.get("id") or ""),
                "company": "",
                "posted_days": _age_days(j.get("createdAt")),
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
                "job_id": str(j.get("id") or ""),
                "company": "",
                "posted_days": _age_days(j.get("publishedAt") or j.get("updatedAt")),
                "location": _place(j.get("location")),
                "url": j.get("jobUrl") or j.get("applyUrl") or "",
                "jd": _text(j.get("descriptionPlain") or j.get("descriptionHtml") or ""),
            })
    elif vendor == "smartrecruiters":
        for j in (payload or {}).get("content") or []:
            loc = j.get("location") if isinstance(j.get("location"), dict) else {}
            where = (loc.get("fullLocation")
                     or ", ".join(p for p in (loc.get("city"), loc.get("region"),
                                              loc.get("country")) if p))
            if loc.get("remote") and "remote" not in where.lower():
                where = f"Remote — {where}" if where else "Remote"
            job_id = str(j.get("id") or j.get("uuid") or "")
            out.append({
                "title": j.get("name") or "",
                "job_id": job_id,
                "company": ((j.get("company") or {}).get("name") or "").strip(),
                "posted_days": _age_days(j.get("releasedDate")),
                "location": where,
                # The list endpoint carries no body text at all; `_enrich` fetches
                # it for the few postings that survive the gates.
                "jd": "",
                "url": f"https://jobs.smartrecruiters.com/{slug}/{job_id}" if job_id else "",
            })
    elif vendor == "workable":
        # The account's own name, which is the only place a Workable payload
        # states the employer — the posting URL often does not carry the slug.
        account = ((payload or {}).get("name") or "").strip()
        for j in (payload or {}).get("jobs") or []:
            where = ", ".join(
                p for p in (j.get("city"), j.get("state"), j.get("country")) if p
            )
            if str(j.get("telecommuting") or "").lower() in ("true", "1"):
                where = f"Remote — {where}" if where else "Remote"
            out.append({
                "title": j.get("title") or "",
                "job_id": str(j.get("shortcode") or j.get("id") or ""),
                "company": account or slug,
                "posted_days": _age_days(j.get("published_on") or j.get("created_at")),
                "location": where,
                "jd": _text(j.get("description") or "", j.get("requirements") or ""),
                "url": j.get("application_url") or j.get("url") or j.get("shortlink") or "",
            })
    elif vendor == "keka":
        # Keka answers with a bare array, and several of its fields are Python
        # reprs rather than JSON — jobLocations comes back as
        # "[{'id': 181, 'name': 'Mumbai', ...}]", single quotes and all. That is
        # not a shape json.loads can read, so the values are pulled out with a
        # pattern instead of being parsed; guessing at the structure would drop
        # every Indian city on the board over a quoting style.
        for j in payload or []:
            job_id = str(j.get("id") or "")
            out.append({
                "title": j.get("title") or "",
                "job_id": job_id,
                # The portal states the employer's legal name in careerportalinfo,
                # but _board caches only the postings; the slug IS the company on
                # Keka (ketto.keka.com), so it is the honest fallback.
                "company": slug,
                "posted_days": _age_days(j.get("publishedOn")),
                "location": _keka_places(j.get("jobLocations")),
                "jd": _text(
                    j.get("description") or "",
                    j.get("excerpt") or "",
                    _keka_list(j.get("skillNames")),
                ),
                "url": f"https://{slug}.keka.com/careers/jobdetails/{job_id}" if job_id else "",
            })
    for p in out:
        p.setdefault("job_id", "")
        p.setdefault("company", "")
        p.setdefault("posted_days", None)
    return [p for p in out if p["url"]]


# Keka embeds structured data as a Python repr inside a JSON string. Both of
# these read values out of it without pretending it is parseable JSON.
_KEKA_CITY = re.compile(r"'(?:city|name)':\s*'([^']+)'")
_KEKA_ITEM = re.compile(r"'([^']+)'")


def _keka_places(raw) -> str:
    """"[{'id': 181, 'name': 'Mumbai', 'city': 'Mumbai', 'countryCode': 'IN'}]"
    -> "Mumbai". Deduplicated in first-seen order so a two-city posting reads
    "Mumbai, Pune" rather than "Mumbai, Mumbai, Pune, Pune"."""
    if not raw:
        return ""
    seen: list[str] = []
    for city in _KEKA_CITY.findall(str(raw)):
        if city and city not in seen:
            seen.append(city)
    return ", ".join(seen)


def _keka_list(raw) -> str:
    """"['Python', 'SQL']" -> "Python, SQL". Feeds the JD text the matcher
    scores against, so an unparsed skills list is a posting that looks
    irrelevant to a candidate who is a perfect fit for it."""
    if not raw:
        return ""
    return ", ".join(_KEKA_ITEM.findall(str(raw)))


# A posting older than this is treated as gone. Boards leave filled roles up for
# months, and an application to one costs a daily slot to receive no reply.
MAX_AGE_DAYS = int(os.environ.get("GRINDLY_MAX_POSTING_AGE_DAYS", "120"))


def _wanted(p: dict) -> bool:
    """An internship, in India, still open.

    The intern test is `websource`'s, so the two sources cannot drift into
    different opinions about what an internship is — and it is a word-boundary
    match, because a substring test files "Head of SOX and Internal Controls"
    as an internship.
    """
    if not _INDIA.search(p["location"] or ""):
        return False
    age = p.get("posted_days")
    # Unknown age is not stale — some boards publish no date at all, and
    # rejecting those would silently drop whole vendors.
    if isinstance(age, int) and age > MAX_AGE_DAYS:
        return False
    return websource._looks_like_an_internship(p["title"], p["jd"][:600])


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


def _enrich(vendor: str, slug: str, posting: dict) -> str:
    """Fetch a posting's description when the list endpoint carried none.

    Only called for postings that already passed the internship and India gates,
    so this is a handful of requests per run, not one per opening on the board.
    A board with 4,700 openings would otherwise cost 4,700 round trips to read
    four internships.
    """
    template = _DETAIL_API.get(vendor)
    if not template or not posting.get("job_id"):
        return ""
    detail = _get_json(template.format(slug=slug, job_id=posting["job_id"]))
    if not isinstance(detail, dict):
        return ""
    ad = detail.get("jobAd") or {}
    sections = (ad.get("sections") or {}) if isinstance(ad, dict) else {}
    parts = []
    for key in ("companyDescription", "jobDescription", "qualifications", "additionalInformation"):
        section = sections.get(key)
        if isinstance(section, dict):
            parts.append(str(section.get("text") or ""))
    return _text(*parts)


def fetch(keywords: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    """Internships posted on employers' own ATS boards. Never raises."""
    targets = [(v, s) for v, slugs in BOARDS.items() for s in sorted(set(slugs))]
    learned = 0
    for vendor, slug in _slugs_seen_before():
        if (vendor, slug) not in targets:
            targets.append((vendor, slug))
            learned += 1

    found: list[tuple[int, dict]] = []
    # Keyed by canonical identity, not URL: Greenhouse publishes the same job on
    # three hosts, and keying on the address counts one posting as three.
    seen: set[str] = set()
    needs_enrichment: list[tuple[str, str, dict, dict]] = []
    # Modest fan-out: these are a handful of vendors' APIs, not a search engine,
    # and a burst that gets this server's IP throttled would take the one working
    # discovery path down with it.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
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
                key = canonical_key(p["url"], vendor, slug, p.get("job_id", ""))
                if key in seen or not _wanted(p):
                    continue
                seen.add(key)
                jd = p["jd"]
                job = {
                    "external_id": hashlib.sha1(key.encode()).hexdigest()[:16],
                    "canonical": key,
                    "vendor": vendor,
                    "title": websource._clean_title(p["title"]),
                    # The board's own company name where it gave one; the URL slug
                    # is a fallback that yields "Stable Money1" and "Bookeeapp".
                    "company": (p.get("company")
                                or websource._company_from(p["title"], p["url"])),
                    "location": p["location"][:80],
                    "posted_days": p.get("posted_days"),
                    "stipend": websource.parse_stipend(jd),
                    "pay_note": websource.parse_pay_note(jd),
                    "duration": websource.parse_duration(jd),
                    "skills": websource._infer_skills(f"{p['title']} {jd}"),
                    "url": p["url"],
                    "jd_text": jd,
                    "source": SOURCE,
                    "offsite_apply": bool(p.get("offsite_apply")),
                }
                found.append((_relevance(p, keywords or []), job))
                if not jd:
                    needs_enrichment.append((vendor, slug, p, job))

    # Descriptions, only for what survived. Parallel because each is one GET and
    # the matcher cannot score what it cannot read.
    if needs_enrichment:
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            for (vendor, slug, posting, job), jd in zip(
                needs_enrichment,
                ex.map(lambda t: _enrich(t[0], t[1], t[2]), needs_enrichment),
            ):
                if jd:
                    job["jd_text"] = jd
                    job["stipend"] = websource.parse_stipend(jd)
                    job["pay_note"] = websource.parse_pay_note(jd)
                    job["duration"] = websource.parse_duration(jd)
                    job["skills"] = websource._infer_skills(
                        f"{job['title']} {jd}") or job["skills"]
    _save_cache()

    # Freshest first among equally relevant postings: an unknown date sorts as
    # if it were at the age limit, so a dated posting always wins the tie.
    found.sort(key=lambda pair: (
        -pair[0],
        pair[1].get("posted_days") if isinstance(pair[1].get("posted_days"), int) else MAX_AGE_DAYS,
    ))
    jobs = _drop_postings_that_leave_the_ats(
        [j for _, j in found[: max(1, limit)]]
    )
    print(f"[atsboards] {len(jobs)} employer-hosted internship(s) from "
          f"{len(targets)} board(s) across {len(BOARDS)} vendor(s); "
          f"{learned} board(s) learned from earlier discovery")
    return jobs


# How a company slug appears in each vendor's URLs. Used to learn new boards
# from postings the rest of the system already found.
_SLUG_PATTERNS = (
    ("greenhouse", r"greenhouse\.io/(?:embed/job_board\?for=)?([^/?#]+)"),
    ("lever", r"lever\.co/([^/?#]+)"),
    ("ashby", r"ashbyhq\.com/([^/?#]+)"),
    ("smartrecruiters", r"smartrecruiters\.com/(?:v1/companies/)?([^/?#]+)"),
    # Two shapes, two entries. Written as one alternation, the branch matching
    # the HOST won on `apply.workable.com/thirdco/...` and captured "apply" —
    # a reserved word, so the company was silently never learned.
    ("workable", r"apply\.workable\.com/([^/?#]+)"),
    ("workable", r"//([^/?#.]+)\.workable\.com"),
)

# Path segments that are part of the ATS's own URL structure, never a company.
_NOT_A_SLUG = {"embed", "jobs", "job", "v1", "companies", "apply", "boards",
               "posting-api", "job-board", "postings", "api", "widget"}


def slugs_from_urls(urls) -> set[tuple[str, str]]:
    """Every (vendor, company) pair named by these URLs."""
    out: set[tuple[str, str]] = set()
    for url in urls or []:
        for vendor, pattern in _SLUG_PATTERNS:
            m = re.search(pattern, url or "", re.I)
            if not m:
                continue
            slug = next((g for g in m.groups() if g), "")
            if slug and slug.lower() not in _NOT_A_SLUG:
                out.add((vendor, slug))
    return out


# Boards learned from the open web, on the shared data volume.
#
# The database path only closes the loop across RUNS, and only after a listing
# has been written — so a company a search surfaced this morning was not asked
# directly until tomorrow at the earliest. This file closes it inside a single
# run: websource hands over every ATS URL it sees the moment it sees it, and
# atsboards polls those companies in the same sweep. It is also the reason the
# board list grows at all on an install that has never applied to anything.
_LEARNED_FILE = os.path.join(
    os.environ.get("GRINDLY_DATA_DIR")
    or os.path.join(os.path.dirname(__file__), "..", "data"),
    "ats_slugs.json",
)
_LEARNED: set[tuple[str, str]] = set()
_learned_loaded = False
LEARNED_MAX = int(os.environ.get("GRINDLY_ATS_LEARNED_MAX", "1200"))


def _load_learned() -> None:
    global _learned_loaded
    if _learned_loaded:
        return
    _learned_loaded = True  # first: a corrupt file must not be reread per call
    try:
        with open(_LEARNED_FILE, encoding="utf-8") as f:
            for vendor, slug in json.load(f) or []:
                if vendor in _API:
                    _LEARNED.add((vendor, slug))
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print(f"[atsboards] learned-slug load skipped: {type(e).__name__}")


# A company slug is one path segment of a URL. Anything with an escape sequence
# or punctuation beyond -_. came out of a mis-parse — live, that produced
# "Ouro%20Careers%20Page" and "oops", each costing one 404 per board poll for as
# long as it stayed on the list.
_PLAUSIBLE_SLUG = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,60}$")


def remember_slugs(urls) -> int:
    """Learn the companies behind these URLs. Returns how many were new."""
    _load_learned()
    fresh = {pair for pair in slugs_from_urls(urls)
             if pair[0] in _API and pair not in _LEARNED
             and _PLAUSIBLE_SLUG.match(pair[1])}
    if not fresh:
        return 0
    _LEARNED.update(fresh)
    # Bounded so a bad day of results cannot grow the poll list without limit;
    # sorted so the trim is deterministic rather than whichever set order won.
    trimmed = sorted(_LEARNED)[:LEARNED_MAX]
    _LEARNED.clear()
    _LEARNED.update(trimmed)
    try:
        os.makedirs(os.path.dirname(_LEARNED_FILE), exist_ok=True)
        tmp = _LEARNED_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(sorted(_LEARNED), f)
        os.replace(tmp, _LEARNED_FILE)  # atomic: a half-written list is a corrupt one
    except Exception as e:  # noqa: BLE001
        print(f"[atsboards] learned-slug save skipped: {type(e).__name__}")
    print(f"[atsboards] learned {len(fresh)} new board(s) from discovery "
          f"({len(_LEARNED)} known)")
    return len(fresh)


def _slugs_seen_before() -> list[tuple[str, str]]:
    """Boards the rest of the system has already discovered.

    Discovery that only ever looks at a hardcoded list can never learn. Any ATS
    URL that has ever been recorded names a company worth asking directly from
    then on — which is how this source grows without anyone editing BOARDS.
    """
    _load_learned()
    out: set[tuple[str, str]] = set(_LEARNED)
    try:
        import db  # local: agent modules import db lazily, tests run without one

        out |= slugs_from_urls(db.known_ats_urls())
    except Exception:  # noqa: BLE001 — no database is not a reason to discover nothing
        pass
    return sorted(out)


def close(uid: str = "") -> None:
    """No browser context to release — kept so worker.py can call close() on
    every source without special-casing this one."""
    return None
