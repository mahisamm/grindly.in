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
import re

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
    '"{domain} intern" India apply site:lever.co',
    '"{domain} internship" India site:boards.greenhouse.io',
    '"{domain} internship" India site:jobs.ashbyhq.com',
    '{domain} internship India "apply now" careers 2026',
    '{domain} internship India application form "google form"',
]

_INTERN_WORDS = ("intern", "internship", "trainee", "apprentice")
_STALE_WORDS = ("2019", "2020", "2021", "2022", "2023")


def enabled() -> bool:
    """Both switches must agree: the feature flag AND a usable provider. A flag
    on with no reachable search backend would log one failure per query and
    discover nothing."""
    return flags.search_discovery_enabled() and websearch.configured()


def _looks_like_an_internship(title: str, snippet: str) -> bool:
    """Cheap relevance gate before anything expensive touches this result.

    Search returns careers-page indexes and blog posts alongside real postings.
    Requiring an intern-ish word in the title or snippet is not a match score —
    matcher.py still scores every survivor against the user's resume — it just
    keeps the resolver's page budget for things that could plausibly be applied
    to.
    """
    blob = f"{title} {snippet}".lower()
    if not any(w in blob for w in _INTERN_WORDS):
        return False
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
    # Strip the "| Company | Careers" tails that search results carry.
    t = re.split(r"\s+[|\-–—]\s+", title.strip())[0]
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

    print(f"[websource] {len(jobs)} employer-hosted candidate(s) from {websearch.provider()}")
    return jobs


def close(uid: str = "") -> None:
    """No browser context to release — kept so worker.py can call close() on
    every source without special-casing this one."""
    return None
