"""Discovery source: internships on employers' OWN pages, found by web search.

This is the source that makes unattended applying possible at all. Every board
adapter returns listings whose only apply path is that board — which needs the
user's account, and on LinkedIn/Naukri/Indeed/Unstop is never submitted from our
servers (resolver.TIER_C). Searching the open web instead surfaces the same
internships where the EMPLOYER published them: a careers page, a Google Form, an
ATS posting. The candidate holds no account there, so there is no account to
lose, and resolver grades those TIER_A — the one tier the agent may submit on
its own.

Same `fetch(domains, limit, uid) -> [job dict]` contract as every board adapter,
so worker.py treats it as one more source. It opens no browser: search results
plus the resolver's existing link-following are enough to reach a real form.
"""
from __future__ import annotations
import hashlib
import html
import re
import urllib.request

import flags
import websearch

# Must match this module's import name: worker.py resolves a listing's source
# back to its module with importlib.import_module(source), so a mismatch here
# would strand every one of these listings at "source unavailable this run".
SOURCE = "websource"

# Query templates. Each aims at a page an employer OWNS, not a board listing:
# ATS hosts are where a company's own postings live, and "apply"/"careers"
# wording is what a real application page says about itself.
_TEMPLATES = [
    # site:-scoped ATS queries carry this source. Verified against the live
    # instance: they return real Indian employers' own postings (Paytm, FamPay,
    # Epifi, Graviton, Ogilvy...), many of them the /apply page itself. Every
    # one is TIER_A — the candidate holds no account there.
    "site:boards.greenhouse.io {domain} intern india",
    "site:jobs.lever.co {domain} intern india",
    "site:jobs.ashbyhq.com {domain} intern india",
    # Employer-owned forms outside the big three ATSs.
    "{domain} internship india apply site:docs.google.com/forms",
    "{domain} internship india careers apply 2026",
]

# Deliberately UNQUOTED. An exact-phrase query ("web development intern")
# matches almost nothing on a real posting, whose title is "Software Developer
# Intern" or "SDE Intern - Frontend"; the first live run returned zero for every
# quoted template while the unquoted equivalents returned twenty.

_INTERN_WORDS = ("intern", "internship", "trainee", "apprentice")
_STALE_WORDS = ("2019", "2020", "2021", "2022", "2023")


def enabled() -> bool:
    """Both switches must agree: the feature flag AND a usable provider. A flag
    on with no reachable search backend would log one failure per query and
    discover nothing."""
    return flags.search_discovery_enabled() and websearch.configured()


# A real posting lives at a per-job path. A company's ATS landing page —
# jobs.lever.co/acme — lists every opening and has no form of its own, so it can
# never be applied to. Live proof: "Careers", "Level AI" and "Stable Money" all
# arrived as candidates and scored on the aggregate text of dozens of unrelated
# roles.
_ATS_POSTING = re.compile(
    r"(?:jobs\.lever\.co/[^/]+/[0-9a-f-]{8,}"          # lever: company/uuid
    r"|greenhouse\.io/[^/]+/jobs/\d+"                   # greenhouse: company/jobs/id
    r"|ashbyhq\.com/[^/]+/[0-9a-f-]{8,}"                # ashby: company/uuid
    r"|docs\.google\.com/forms)", re.I,
)
_ATS_HOST = re.compile(r"(?:lever\.co|greenhouse\.io|ashbyhq\.com)", re.I)

# Titles that belong to an index page rather than one role.
_INDEX_TITLES = re.compile(
    r"^(careers?|jobs?|openings?|work with us|current openings|"
    r"job application for)?$", re.I,
)


def _is_a_single_posting(title: str, url: str) -> bool:
    """Is this one applyable role, or a company's list of roles?

    On a known ATS the URL settles it: a per-job path is a posting, a bare
    company path is the index. Elsewhere we cannot tell from the URL, so fall
    back to the title — an index page is usually titled just "Careers" or the
    company's own name.
    """
    if _ATS_HOST.search(url):
        return bool(_ATS_POSTING.search(url))
    return not _INDEX_TITLES.match(title.strip())


def _looks_like_an_internship(title: str, snippet: str) -> bool:
    """Cheap relevance gate before anything expensive touches this result.

    Search returns careers-page indexes and blog posts alongside real postings.
    Requiring an intern-ish word in the title or snippet is not a match score —
    matcher.py still scores every survivor against the user's resume — it just
    keeps the resolver's page budget for things that could plausibly be applied
    to.
    """
    # The TITLE must say intern, not merely the page somewhere.
    #
    # Matching on title-or-snippet let a company's ATS index through whenever
    # any listed role happened to be an internship — "Level AI", "Drivetrain"
    # and "Endpoint Clinical" all arrived that way, and one reached the queue as
    # a "Director, Commercial Operations" internship. A real posting names the
    # role in its title; that is the one reliable signal here, and a few missed
    # listings cost far less than applying to the wrong job in someone's name.
    if not any(w in title.lower() for w in _INTERN_WORDS):
        return False
    blob = f"{title} {snippet}".lower()
    # A posting whose text advertises a long-past year is almost always an
    # archived page; applying there is noise to the employer and to the user.
    if any(y in blob for y in _STALE_WORDS) and "2026" not in blob:
        return False
    return True


def _company_from(title: str, url: str) -> str:
    """Best-effort employer name.

    ATS URLs carry the company as a path segment, which is more reliable than
    parsing a page title. Otherwise fall back to the title's "at <Company>" or
    the host. Never returns empty — an application filed under a blank company
    is unreadable on the dashboard.
    """
    m = re.search(r"(?:lever\.co|greenhouse\.io|ashbyhq\.com)/([^/?#]+)", url, re.I)
    if m:
        return m.group(1).replace("-", " ").replace("_", " ").strip().title()[:60]
    m = re.search(r"\bat\s+([A-Z][\w&.\- ]{2,40})", title)
    if m:
        return m.group(1).strip()[:60]
    host = re.sub(r"^www\.", "", re.sub(r"^https?://", "", url).split("/")[0])
    return (host.split(".")[0] or "Unknown").title()[:60]


def _clean_title(title: str) -> str:
    # Strip the "| Company | Careers" tails that search results carry, and the
    # "Job Application for ..." prefix Greenhouse puts on every page title —
    # left in, it becomes the role name shown on the user's dashboard.
    t = re.split(r"\s+[|\-–—]\s+", title.strip())[0]
    t = re.sub(r"^job application for\s+", "", t, flags=re.I)
    t = re.sub(r"\s+at\s+[A-Z][\w&.\- ]{2,40}$", "", t)
    return (t or title).strip()[:120]


def _infer_skills(text: str) -> list[str]:
    known = (
        "python", "java", "javascript", "typescript", "react", "node", "django",
        "flask", "sql", "postgresql", "mongodb", "aws", "docker", "kubernetes",
        "figma", "excel", "tableau", "power bi", "machine learning", "nlp",
        "android", "ios", "flutter", "marketing", "seo", "content", "design",
    )
    low = text.lower()
    return [k for k in known if k in low][:8]


_TAGS = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
_MARKUP = re.compile(r"<[^>]+>")


def scrape_jd(url: str, uid: str = "") -> str:
    """Fetch the real job description behind a search result.

    Not an optimisation — it is what makes these listings scoreable at all. A
    board card arrives with a skills list; a search result arrives with a
    one-line snippet, so matcher.score_job saw "0 of your skills mentioned" and
    scored every employer-hosted internship ~5 against a threshold of 65. Real
    roles at DevRev, CloudSEK, Thena and Enterpret were discarded that way. The
    worker's own JD re-scoring could not rescue them either: it only re-reads
    the top few by initial score, which is exactly the score being starved.

    Plain HTTP, no browser — ATS postings are server-rendered. Returns "" on any
    failure; the caller keeps the snippet and the listing simply scores as it
    did before.
    """
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"),
            "Accept-Language": "en-IN,en;q=0.9",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read(400_000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        print(f"[websource] jd fetch failed ({type(e).__name__}) for {url[:60]}")
        return ""
    text = _MARKUP.sub(" ", _TAGS.sub(" ", raw))
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()[:6000]


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    """Search the web for employer-hosted internships in these domains."""
    if not enabled():
        return []

    jobs: list[dict] = []
    seen: set[str] = set()
    # Budget queries: this runs per user per sweep, and a self-hosted metasearch
    # instance that hammers its upstream engines gets the server's IP blocked —
    # which would end discovery for every user at once.
    per_domain = max(1, min(3, len(_TEMPLATES)))

    for domain in (domains or [])[:3]:
        for template in _TEMPLATES[:per_domain]:
            if len(jobs) >= limit:
                break
            for r in websearch.search(template.format(domain=domain), limit=8):
                url = r["url"]
                if url in seen:
                    continue
                seen.add(url)
                if not _looks_like_an_internship(r["title"], r["snippet"]):
                    continue
                title = _clean_title(r["title"])
                # An index page has no form to submit; scoring it means scoring
                # the aggregate text of every unrelated role the company lists.
                if not _is_a_single_posting(title, url):
                    continue
                jobs.append({
                    # Stable across runs so the same posting dedupes instead of
                    # reappearing as new work every sweep.
                    "external_id": hashlib.sha1(url.encode()).hexdigest()[:16],
                    "title": title,
                    "company": _company_from(r["title"], url),
                    "location": "",
                    "stipend": "",
                    "duration": "",
                    "skills": _infer_skills(f"{title} {r['snippet']}"),
                    "url": url,
                    "jd_text": r["snippet"],
                    "source": SOURCE,
                })
                if len(jobs) >= limit:
                    break

    # Enrich with the real posting text BEFORE these are scored. Bounded by the
    # candidate list itself (a dozen or so), each a plain HTTP GET.
    enriched = 0
    for j in jobs:
        jd = scrape_jd(j["url"], uid)
        if len(jd) > len(j["jd_text"]):
            j["jd_text"] = jd
            # Re-derive skills from the full text; the title alone rarely names
            # the stack, and skills are what the matcher actually compares on.
            j["skills"] = _infer_skills(f"{j['title']} {jd}") or j["skills"]
            enriched += 1

    print(f"[websource] {len(jobs)} employer-hosted candidate(s) from "
          f"{websearch.provider()} ({enriched} with a full description)")
    return jobs


def close(uid: str = "") -> None:
    """No browser context to release — kept so worker.py can call close() on
    every source without special-casing this one."""
    return None
