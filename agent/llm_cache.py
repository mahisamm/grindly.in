"""A disk cache for model answers that should not change.

WHY THIS EXISTS

Four of the five providers are free tiers, and the quota they share is the
product's real constraint: a campus placement week is exactly when every free
tier is thinnest and exactly when the most people are uploading resumes. Every
call that did not have to happen is one someone else gets to make.

Two calls in this pipeline are asked repeatedly with byte-identical input, and
they are the two this cache is for:

  * A job description, parsed once when a target is created and again on every
    rebuild against that target. The requirements in a posting do not change
    because someone pressed a button twice.
  * A company lookup. The same fifty or so employers are typed by everyone, and
    this is the highest-hit-rate call in the product.

WHAT IS DELIBERATELY NOT CACHED, and why each one is a decision rather than an
omission:

  * REWRITES. "Run again" has to be able to produce something new; a cached
    rewrite would make the button a lie.
  * ADVICE. `resume_ai.advise` always returns a well-formed dict, filling it
    from a heuristic when no provider answers — so nothing in the shape tells a
    real review apart from an outage, and a cache would serve the outage for a
    week under a panel titled "A recruiter's read". It is already persisted per
    resume in the database anyway.
  * A DECLINED COMPANY, or a job description with no requirements read out of
    it. Both are the correct answer in the moment AND the answer a rate-limited
    provider produces, and the two are indistinguishable from here.
  * A CURATED PACK, which is read from a file on disk and costs nothing.

The pattern in all four: never cache an answer that a bad minute could have
produced. This is therefore opt-in at each call site rather than a layer under
`llm.chat_*` — a general cache would have no way to make that distinction.

WHY A FILE AND NOT A TABLE

The Python side is a pure function of its input with no database handle, by
design — that is the whole architecture note at the top of cli.py, and reaching
for Postgres here would undo it. Files are enough: the key is a hash, the values
are small, and a cache that is lost is a cache that costs one more call.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time

# Configuration is read at CALL time, not at import.
#
# It was module-level constants, and that is a bug with a long tail: the process
# reads `GRINDLY_LLM_CACHE=0` once, at import, before any caller has had a
# chance to set it — so the documented off switch did nothing, and the test
# suite's attempt to disable the cache silently failed while appearing to work.
# The functions below cost one dict lookup each.


def _dir() -> str:
    """Where entries live.

    Under `data/` with the resumes and variants, so one volume mount covers
    everything the agent writes and a deploy that forgets it loses a cache
    rather than user documents.
    """
    return os.environ.get("GRINDLY_LLM_CACHE_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "llm-cache"
    )


def _ttl_seconds() -> int:
    """How long an entry is trusted.

    Seven days is a compromise between two real cases. A job description parsed
    today and re-used on Friday should not cost a second call. A company pack
    generated from what a model knows should not be served for a month, because
    the honest answer for a company changes when it publishes something.
    """
    try:
        return max(60, int(os.environ.get("GRINDLY_LLM_CACHE_TTL", str(7 * 86400))))
    except ValueError:
        return 7 * 86400


def _enabled() -> bool:
    """On unless told otherwise — a developer debugging a prompt needs to see
    what the model says now, not what it said an hour ago."""
    return os.environ.get("GRINDLY_LLM_CACHE", "1").strip().lower() not in (
        "0", "false", "no", "off",
    )


def _max_entries() -> int:
    """A cap, swept on write. Each entry is a few kilobytes; this bounds the
    directory at roughly ten megabytes."""
    try:
        return max(50, int(os.environ.get("GRINDLY_LLM_CACHE_MAX", "2000")))
    except ValueError:
        return 2000


def key(kind: str, *parts: object) -> str:
    """A stable key for a call.

    `kind` separates namespaces, so a resume's text cached as a struct
    extraction cannot be served to a request for advice about the same text.
    Everything else is hashed, which also means no user text is ever written
    into a filename.
    """
    payload = json.dumps([kind, *[str(p) for p in parts]], sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:40]


def _path(cache_key: str) -> str:
    return os.path.join(_dir(), f"{cache_key}.json")


def get(cache_key: str):
    """The cached value, or None. Never raises."""
    if not _enabled():
        return None
    try:
        path = _path(cache_key)
        with open(path, "r", encoding="utf-8") as handle:
            entry = json.load(handle)
        if not isinstance(entry, dict):
            return None
        if time.time() - float(entry.get("at") or 0) > _ttl_seconds():
            # Expired. Removed on read rather than by a sweep, so a key that is
            # never asked for again never costs anything to keep.
            try:
                os.remove(path)
            except OSError:
                pass
            return None
        return entry.get("value")
    except (OSError, ValueError, TypeError):
        return None


def put(cache_key: str, value) -> None:
    """Store a value. Never raises — a cache write that fails is not an error."""
    if not _enabled() or value is None:
        return
    try:
        os.makedirs(_dir(), exist_ok=True)
        path = _path(cache_key)
        # Written to a temp file and renamed, so a process killed mid-write
        # leaves the old entry rather than a truncated one that every later read
        # has to defend against.
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump({"at": time.time(), "value": value}, handle)
        os.replace(tmp, path)
        _sweep()
    except (OSError, TypeError, ValueError) as error:
        print(f"[cache] could not write: {error}", file=sys.stderr)


def _sweep() -> None:
    """Drop the oldest entries when the directory grows past its cap."""
    try:
        directory = _dir()
        limit = _max_entries()
        names = [n for n in os.listdir(directory) if n.endswith(".json")]
        if len(names) <= limit:
            return
        paths = [os.path.join(directory, n) for n in names]
        paths.sort(key=lambda p: os.path.getmtime(p))
        for path in paths[: len(paths) - limit]:
            try:
                os.remove(path)
            except OSError:
                pass
    except OSError:
        pass


def cached(kind: str, parts: list, produce):
    """Return a cached answer for this call, or produce and store one.

    `produce` is only invoked on a miss. A falsy result is NOT cached: an empty
    answer is what a rate-limited provider returns, and caching that would turn
    one bad minute into a week of them.
    """
    cache_key = key(kind, *parts)
    hit = get(cache_key)
    if hit is not None:
        print(f"[cache] hit: {kind}", file=sys.stderr)
        return hit
    value = produce()
    if value:
        put(cache_key, value)
    return value
