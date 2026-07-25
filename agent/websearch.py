"""Web search, behind one interface, so the provider is a config choice.

Discovery used to be limited to what the job boards show, and boards deliberately
hide the employer's own apply link — their business is that you apply THROUGH
them. But most India student internships are also posted on the company's own
careers page or a Google Form, and those are reachable only by searching the
open web. Those destinations need no account of the user's, which is what makes
them safe to submit unattended (resolver.TIER_A).

Default provider is a self-hosted SearXNG on the compose network: no key, no
per-query cost, no quota to exhaust. Set GRINDLY_SEARCH_PROVIDER=serper (or
tavily) plus SEARCH_API_KEY to switch to a hosted API without touching code —
the swap exists because a self-hosted metasearch instance can be rate-limited by
its upstream engines, and the fix should be an env var, not a rewrite.

Every provider returns the same shape: [{"title", "url", "snippet"}].
Failure is always an empty list, never an exception: discovery must degrade to
"found nothing this run", never take the run down.
"""
from __future__ import annotations
import json
import os
import urllib.parse
import urllib.request

TIMEOUT = int(os.environ.get("GRINDLY_SEARCH_TIMEOUT", "20"))

# Domains whose "results" are never an employer's own application page. Boards
# are handled by their own adapters, and aggregator/spam mirrors reprint the same
# listing without ever owning an apply form.
# Matched as a DOMAIN LABEL, not a full host: these brands run one site per
# country ("glassdoor.co.in", "indeed.co.uk", "uk.linkedin.com"), and a
# suffix-match list of ".com" names lets every regional twin straight through —
# which is how a Glassdoor link survived the filter in the first live run.
_EXCLUDED_BRANDS = {
    # Job boards. Either an adapter already owns them, or applying needs the
    # user's account there, which is never submitted from our servers.
    "linkedin", "indeed", "naukri", "unstop", "internshala", "glassdoor",
    "monster", "shine", "timesjobs", "simplyhired", "ziprecruiter", "jooble",
    "neuvoo", "foundit", "hirist", "cutshort", "instahyre", "apna",
    # Aggregators and scraped mirrors: they reprint a listing and own no form.
    "myinternships", "internshipdunia", "letsintern", "twenty19", "jobsuche",
    "careerjet", "trovit", "adzuna", "talent", "jora", "whatjobs", "expertini",
    # Social, docs and reference — never an application page.
    "facebook", "twitter", "instagram", "reddit", "youtube", "quora",
    "pinterest", "medium", "wikipedia", "wikimedia", "whatsapp", "telegram",
    "blogspot", "wordpress", "amazon", "flipkart",
}


def provider() -> str:
    return (os.environ.get("GRINDLY_SEARCH_PROVIDER") or "searxng").strip().lower()


def configured() -> bool:
    """Can this provider actually run? A hosted API without its key cannot, and
    saying so here keeps the caller from logging a failure per query."""
    if provider() == "searxng":
        return bool(_searxng_url())
    return bool(os.environ.get("SEARCH_API_KEY"))


def _searxng_url() -> str:
    return (os.environ.get("SEARXNG_URL") or "http://searxng:8080").rstrip("/")


def _host_of(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url).hostname or "").lower().lstrip("www.")
    except Exception:  # noqa: BLE001
        return ""


def _is_useful(url: str) -> bool:
    """Could this URL plausibly be an employer's own application page?

    Rejects on any domain label matching an excluded brand, so "glassdoor.co.in",
    "uk.linkedin.com" and "in.indeed.com" all go with the parent. Cheap and
    deliberately blunt — the point is to stop spending the resolver's page
    budget on hosts that can never hold a form the agent may submit."""
    host = _host_of(url)
    if not host:
        return False
    labels = set(host.split("."))
    return not (labels & _EXCLUDED_BRANDS)


def _get_json(url: str, headers: dict | None = None, payload: dict | None = None) -> dict | None:
    try:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(url, data=data, headers=headers or {})
        if data is not None:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print(f"[websearch] {type(e).__name__}: {str(e)[:120]}")
        return None


def _from_searxng(query: str, limit: int) -> list[dict]:
    url = (
        f"{_searxng_url()}/search?"
        + urllib.parse.urlencode({"q": query, "format": "json", "language": "en"})
    )
    # SearXNG rejects a request with no browser-ish UA as a bot.
    data = _get_json(url, headers={"User-Agent": "Grindly/1.0 (+internal discovery)"})
    if not data:
        return []
    out = []
    for r in (data.get("results") or [])[: limit * 3]:
        link = r.get("url") or ""
        if _is_useful(link):
            out.append({
                "title": (r.get("title") or "").strip(),
                "url": link,
                "snippet": (r.get("content") or "").strip()[:400],
            })
    return out[:limit]


def _from_serper(query: str, limit: int) -> list[dict]:
    data = _get_json(
        "https://google.serper.dev/search",
        headers={"X-API-KEY": os.environ.get("SEARCH_API_KEY", "")},
        payload={"q": query, "num": min(20, limit * 2), "gl": "in"},
    )
    if not data:
        return []
    out = []
    for r in (data.get("organic") or []):
        link = r.get("link") or ""
        if _is_useful(link):
            out.append({
                "title": (r.get("title") or "").strip(),
                "url": link,
                "snippet": (r.get("snippet") or "").strip()[:400],
            })
    return out[:limit]


def _from_tavily(query: str, limit: int) -> list[dict]:
    data = _get_json(
        "https://api.tavily.com/search",
        payload={
            "api_key": os.environ.get("SEARCH_API_KEY", ""),
            "query": query,
            "max_results": min(20, limit * 2),
            "search_depth": "basic",
        },
    )
    if not data:
        return []
    out = []
    for r in (data.get("results") or []):
        link = r.get("url") or ""
        if _is_useful(link):
            out.append({
                "title": (r.get("title") or "").strip(),
                "url": link,
                "snippet": (r.get("content") or "").strip()[:400],
            })
    return out[:limit]


_PROVIDERS = {"searxng": _from_searxng, "serper": _from_serper, "tavily": _from_tavily}


def search(query: str, limit: int = 10) -> list[dict]:
    """Run one query. Always returns a list — [] on any failure.

    Job-board and social hosts are filtered out here rather than downstream: a
    board result is either already covered by its own adapter or is a link the
    agent cannot submit to without the user's account, so carrying it further
    only spends the resolver's page budget to reach the same conclusion.
    """
    query = (query or "").strip()
    if not query or not configured():
        return []
    fn = _PROVIDERS.get(provider())
    if fn is None:
        print(f"[websearch] unknown provider {provider()!r} — no results")
        return []
    try:
        return fn(query, max(1, limit))
    except Exception as e:  # noqa: BLE001
        print(f"[websearch] provider {provider()} failed: {str(e)[:120]}")
        return []
