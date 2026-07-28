"""Show what discovery actually finds, and how it found it. Writes nothing.

Discovery is the half of the product nobody can see. The dashboard shows what
survived scoring, the daily cap and the pipeline drip — by the time a listing
reaches a user, every fact about where it came from has been flattened into one
`source` string. When someone asks "is the agent any good at finding
internships?", nothing in the system answers that question.

This runs the SAME code path a live run does — the same plan, the same keyword
expansion, the same rotation, the same adapters — with two differences:

  1. It records provenance. Every web query issued, every ATS board polled, and
     for each listing, the exact query or board that surfaced it.
  2. It persists nothing. No jobs, no applications, no run row, no audit trail.
     A probe must never put work on someone's dashboard.

    python agent/discovery_probe.py --email you@example.com --limit 20
    python agent/discovery_probe.py --email you@example.com --boards --json out.json

`--boards` additionally scrapes the job boards in today's rotation (Playwright,
slow, and blockable). Without it the probe covers only the two employer-hosted
sources, which are the ones that run every single day.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402
import flags  # noqa: E402
import matcher  # noqa: E402
import worker  # noqa: E402


def _user_by_email(email: str) -> dict | None:
    with db.conn() as c:
        row = c.execute(
            "SELECT id, email, name FROM users WHERE lower(email)=?", (email.lower(),)
        ).fetchone()
        return dict(row) if row else None


def _jlist(v) -> list:
    if not v:
        return []
    try:
        return json.loads(v) if isinstance(v, str) else list(v)
    except Exception:  # noqa: BLE001
        return []


# ---- provenance -------------------------------------------------------------
#
# Both employer-hosted sources reach the outside world through exactly one
# function each, so wrapping those two is enough to know every question the
# agent asked — and, by remembering which one was in flight, which question
# produced which listing. Cheaper and far more honest than re-deriving it from
# the results afterwards.


class Trace:
    def __init__(self) -> None:
        self.queries: list[dict] = []      # web searches issued
        self.boards: list[dict] = []       # ATS boards polled
        self.origin: dict[str, str] = {}   # url -> how it was found

    def note_urls(self, urls: list[str], how: str) -> None:
        for u in urls:
            self.origin.setdefault(u, how)


def _instrument(trace: Trace) -> None:
    import atsboards
    import websearch
    import websource

    real_search = websearch.search

    def traced_search(query: str, limit: int = 10):
        t0 = time.time()
        results = real_search(query, limit)
        trace.queries.append({
            "query": query,
            "provider": websearch.provider(),
            "results": len(results),
            "ms": int((time.time() - t0) * 1000),
        })
        trace.note_urls([r.get("url", "") for r in results], f"web search: {query}")
        return results

    websearch.search = traced_search
    # websource imported the name directly, so patching the module alone would
    # leave the copy it actually calls untouched.
    websource.websearch.search = traced_search

    real_board = atsboards._board

    def traced_board(vendor: str, slug: str):
        t0 = time.time()
        payload = real_board(vendor, slug)
        try:
            postings = atsboards._postings(vendor, payload, slug)
        except Exception:  # noqa: BLE001
            postings = []
        wanted = [p for p in postings if atsboards._wanted(p)]
        trace.boards.append({
            "vendor": vendor,
            "slug": slug,
            "postings": len(postings),
            "india_internships": len(wanted),
            "ms": int((time.time() - t0) * 1000),
        })
        trace.note_urls(
            [p["url"] for p in wanted],
            f"{vendor} board API: {atsboards._API[vendor].format(slug=slug).split('?')[0]}",
        )
        return payload

    atsboards._board = traced_board


def probe(email: str, limit: int, with_boards: bool) -> dict:
    user = _user_by_email(email)
    if not user:
        raise SystemExit(f"no account for {email}")
    full = db.get_user(user["id"]) or {}
    profile = full.get("profile") or {}
    skills = _jlist(profile.get("skills"))
    plan = worker.build_plan(profile, skills, cap=limit, user=full)
    kw_sets = worker._expand_search_keywords(plan["domains"], skills)

    sources = [s for s in worker.ALWAYS_ON_SOURCES if flags.source_enabled(s)]
    rotation = worker._platforms_for_today(
        user["id"], [s for s in worker.DISCOVERY_PLATFORMS if flags.source_enabled(s)]
    )
    if with_boards:
        sources = rotation + sources

    trace = Trace()
    _instrument(trace)

    per_source: dict[str, dict] = {}
    jobs: list[dict] = []
    for src in sources:
        mod = worker._load_module(src)
        if mod is None:
            per_source[src] = {"count": 0, "error": "adapter import failed"}
            continue
        t0 = time.time()
        errors: dict[str, str] = {}
        try:
            _, got = worker._fetch_source_all_kw(
                src, mod, kw_sets, max(8, limit), user["id"], errors
            )
        except Exception as e:  # noqa: BLE001
            per_source[src] = {"count": 0, "error": f"{type(e).__name__}: {e}"[:200]}
            continue
        finally:
            close = getattr(mod, "close", None)
            if callable(close):
                try:
                    close(user["id"])
                except Exception:  # noqa: BLE001
                    pass
        per_source[src] = {
            "count": len(got),
            "seconds": round(time.time() - t0, 1),
            **({"error": errors[src]} if src in errors else {}),
        }
        jobs.extend(got)

    # Score exactly as the live run does, so the number here is the number that
    # would have decided whether this listing ever reached the dashboard.
    threshold = plan["min_match_score"]
    scored = []
    for j in jobs:
        score, reason = matcher.score_job(
            j, skills, plan["domains"], profile.get("experience_level"), j.get("jd_text", "")
        )
        scored.append({
            "title": j.get("title", ""),
            "company": j.get("company", ""),
            "location": j.get("location", ""),
            "url": j.get("url", ""),
            "source": j.get("source", ""),
            "skills": j.get("skills", [])[:8],
            "jd_chars": len(j.get("jd_text") or ""),
            "score": score,
            "reason": reason,
            "passes_threshold": score >= threshold,
            "found_via": trace.origin.get(j.get("url", ""), "adapter search"),
        })
    scored.sort(key=lambda r: -r["score"])

    return {
        "user": {"email": user["email"], "id": user["id"]},
        "plan": {
            "domains": plan["domains"],
            "locations": plan["locations"],
            "skills": skills,
            "min_match_score": threshold,
        },
        "keyword_sets": kw_sets,
        "sources_run": sources,
        "rotation_today": rotation,
        "boards_included": with_boards,
        "per_source": per_source,
        "web_queries": trace.queries,
        "ats_boards": trace.boards,
        "listings": scored[:limit],
        "total_found": len(scored),
    }


def _print(rep: dict) -> None:
    print(f"\nuser        {rep['user']['email']}")
    print(f"domains     {rep['plan']['domains']}")
    print(f"keyword sets {rep['keyword_sets']}")
    print(f"sources     {rep['sources_run']}   (rotation today: {rep['rotation_today']})")
    print(f"threshold   {rep['plan']['min_match_score']}")
    print("\nper-source yield")
    for src, info in rep["per_source"].items():
        print(f"  {src:<14} {info}")
    if rep["web_queries"]:
        print(f"\nweb queries ({len(rep['web_queries'])})")
        for q in rep["web_queries"]:
            print(f"  [{q['results']:>2}] {q['query']}")
    if rep["ats_boards"]:
        live = [b for b in rep["ats_boards"] if b["india_internships"]]
        print(f"\nATS boards polled: {len(rep['ats_boards'])}, "
              f"{len(live)} with an India internship open")
        for b in sorted(rep["ats_boards"], key=lambda x: -x["india_internships"])[:20]:
            print(f"  {b['vendor']:<11} {b['slug']:<32} "
                  f"{b['postings']:>4} postings  {b['india_internships']:>2} match")
    print(f"\nlistings ({rep['total_found']} found, showing {len(rep['listings'])})")
    for i, r in enumerate(rep["listings"], 1):
        flag = "PASS" if r["passes_threshold"] else "    "
        print(f"\n{i:>2}. [{r['score']:>3}] {flag}  {r['title']}")
        print(f"     company  {r['company']}   {r['location']}")
        print(f"     source   {r['source']}")
        print(f"     found    {r['found_via']}")
        print(f"     url      {r['url']}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--boards", action="store_true",
                    help="also scrape today's rotated job boards (slow, Playwright)")
    ap.add_argument("--json", help="write the full report to this path")
    args = ap.parse_args()

    rep = probe(args.email, args.limit, args.boards)
    _print(rep)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(rep, f, indent=2)
        print(f"\nfull report -> {args.json}")


if __name__ == "__main__":
    main()
