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
import tempfile
import time
import urllib.parse
import urllib.request

import hosts

TIMEOUT = int(os.environ.get("GRINDLY_SEARCH_TIMEOUT", "20"))

# Which hosts survive a search lives in agent/hosts.py now, as a classification
# rather than a denylist. The list that used to sit here named ~50 brands and
# implicitly trusted everything else; measured live, eight mirror sites nobody
# had written down yet — alexahire, vthetecheejobs, hellointern, jobgrid,
# internshiphub, antaltechjobs, beincareer, ambitionbox — outranked real
# employers in the same run. A denylist can only ever describe yesterday.


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
    return hosts.host_of(url)


def _is_useful(url: str) -> bool:
    """Could this URL plausibly be an employer's own application page?

    Delegates to the shared classifier: an ATS posting or a company's own
    careers path is kept, a job board belongs to its own adapter, and a mirror
    site owns no form to submit. An unrecognised host is KEPT — a small employer
    on a domain nobody has seen is exactly the listing the boards miss — but
    downstream knows not to trust it.
    """
    return hosts.is_useful(url)


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


# Which upstream engines have actually answered this process, and which refused.
# Discovery breadth is bounded by this and nothing reported it: the code
# elsewhere still carried a comment claiming every engine was blocked, written
# during one throttled window and never re-measured. It is a fact about right
# now, so it is recorded rather than assumed.
_ENGINES_ANSWERED: set[str] = set()
_ENGINES_REFUSED: dict[str, str] = {}


def engines_answering() -> list[str]:
    return sorted(_ENGINES_ANSWERED)


def engines_refusing() -> dict[str, str]:
    return dict(_ENGINES_REFUSED)


def _from_searxng(query: str, limit: int) -> list[dict]:
    url = (
        f"{_searxng_url()}/search?"
        + urllib.parse.urlencode({"q": query, "format": "json", "language": "en"})
    )
    # SearXNG rejects a request with no browser-ish UA as a bot.
    data = _get_json(url, headers={"User-Agent": "Grindly/1.0 (+internal discovery)"})
    if not data:
        return []
    for engine, why in (data.get("unresponsive_engines") or []):
        _ENGINES_REFUSED[str(engine)] = str(why)
    out = []
    for r in (data.get("results") or [])[: limit * 3]:
        link = r.get("url") or ""
        _ENGINES_ANSWERED.update(str(e) for e in (r.get("engines") or []))
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


# Resolved by NAME at call time, not by reference at import. Binding the
# functions here would freeze the dispatch table at module load, so swapping a
# provider (or substituting one in a test) would silently keep calling the
# original — the table would say one thing and the code do another.
_PROVIDERS = {"searxng": "_from_searxng", "serper": "_from_serper", "tavily": "_from_tavily"}


# Query -> (unix_ts, results). Upstream engines throttle a datacenter IP after a
# burst, and a throttled minute used to erase a whole run's discovery: the same
# query that returned twenty results returned zero, and the user saw "no
# matches" for a reason that had nothing to do with their job search.
#
# Results are reused for CACHE_TTL. Job postings do not churn minute to minute,
# so a slightly stale list is strictly better than an empty one — and it also
# stops repeat runs from spending fresh quota on a query just answered.
_CACHE: dict[str, tuple[float, list[dict]]] = {}
CACHE_TTL = int(os.environ.get("GRINDLY_SEARCH_CACHE_TTL", "3600"))
_CACHE_MAX = 400

# Backed by a file on the shared data volume, because an in-memory cache dies
# with the process — and the worker is exactly the kind of thing that gets
# restarted on deploy, then immediately starts a run into a throttled backend
# with nothing to fall back on. A plain JSON file costs nothing and outlives
# both the process and the container.
_CACHE_FILE = os.path.join(
    os.environ.get("GRINDLY_DATA_DIR")
    or os.path.join(os.path.dirname(__file__), "..", "data"),
    "search_cache.json",
)
_loaded = False


def _load_cache() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True   # set first: a broken file must not retry on every query
    try:
        with open(_CACHE_FILE, encoding="utf-8") as f:
            raw = json.load(f)
        now = time.time()
        for key, entry in (raw or {}).items():
            ts, results = entry
            if now - ts <= CACHE_TTL and results:
                _CACHE[key] = (ts, results)
        if _CACHE:
            print(f"[websearch] restored {len(_CACHE)} cached quer(ies) from disk")
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001 — a corrupt cache is not worth a failed run
        print(f"[websearch] cache load skipped: {type(e).__name__}")


def _save_cache() -> None:
    try:
        cache_dir = os.path.dirname(_CACHE_FILE)
        os.makedirs(cache_dir, exist_ok=True)
        # Worker and sweep share this volume. A fixed `.tmp` name lets one
        # process replace the other's file before its own atomic replacement.
        fd, tmp = tempfile.mkstemp(prefix=".search_cache-", suffix=".tmp", dir=cache_dir)
        # Newest-first and capped, the same discipline atsboards needed after
        # its own cache reached 425 MB in production. The TTL here governs
        # READS only, so a wholesale dump wrote back every expired entry
        # forever — and now that the cache is consulted before every query
        # rather than only on failure, it fills far faster than it used to.
        now = time.time()
        keep = sorted(
            ((ts, k, r) for k, (ts, r) in _CACHE.items() if now - ts <= CACHE_TTL and r),
            key=lambda row: row[0],
            reverse=True,
        )[:_CACHE_MAX]
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({k: [ts, r] for ts, k, r in keep}, f)
        # Atomic: a half-written cache read by the next process would be a
        # corrupt file that costs a run's discovery.
        os.replace(tmp, _CACHE_FILE)
    except Exception as e:  # noqa: BLE001
        print(f"[websearch] cache save skipped: {type(e).__name__}")


def _cache_get(key: str, allow_stale: bool = False) -> list[dict] | None:
    """The cached answer for this query.

    Two readers with different appetites. The normal one wants a FRESH answer
    and is what stops the fleet re-asking upstream for something it already
    knows. The `allow_stale` one runs only after upstream has come back empty,
    where a stale answer is plainly better than reporting no work — and it must
    not delete the entry, because the next throttled run will want it too.
    """
    _load_cache()
    hit = _CACHE.get(key)
    if not hit:
        return None
    ts, results = hit
    if time.time() - ts > CACHE_TTL:
        if allow_stale:
            return results
        return None
    return results


def _cache_put(key: str, results: list[dict]) -> None:
    # Only cache a real answer. Caching an empty result would turn one throttled
    # moment into an hour of guaranteed silence — the exact failure this exists
    # to prevent.
    if not results:
        return
    _load_cache()
    if len(_CACHE) >= _CACHE_MAX:
        oldest = min(_CACHE, key=lambda k: _CACHE[k][0])
        _CACHE.pop(oldest, None)
    _CACHE[key] = (time.time(), results)
    _save_cache()


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
    fn = globals().get(_PROVIDERS.get(provider(), ""))
    if fn is None:
        print(f"[websearch] unknown provider {provider()!r} — no results")
        return []
    key = f"{provider()}::{query}::{limit}"

    # Serve a fresh cached answer WITHOUT asking upstream.
    #
    # This cache used to be consulted only after the provider came back empty,
    # which meant it never saved a single request on the happy path. Every
    # user's run re-issued the same ~162 searches — and the query set is
    # deliberately role- and host-scoped, so it collapses almost completely
    # across a fleet: the harvest terms are documented as "role-independent on
    # purpose, so they cost the same regardless of who is asking". At 1000
    # users that was ~162,000 upstream queries a day, from one IP, for a few
    # hundred distinct answers — the surest way to get that IP throttled and
    # take the only working discovery path down with it.
    fresh = _cache_get(key)
    if fresh:
        return fresh

    try:
        results = fn(query, max(1, limit))
    except Exception as e:  # noqa: BLE001
        print(f"[websearch] provider {provider()} failed: {str(e)[:120]}")
        results = []
    if results:
        _cache_put(key, results)
        return results
    # Empty almost always means throttled, not "nothing exists". `_cache_get`
    # above already returned anything fresh, so this is the deliberately
    # laxer read: a stale answer beats reporting no work at all.
    cached = _cache_get(key, allow_stale=True)
    if cached:
        print(f"[websearch] upstream returned nothing — reusing {len(cached)} cached result(s)")
        return cached
    return []
