"""Grade a discovery run out of 100, the same way every time.

"Is the agent good at finding internships?" was answerable only by a human
reading a list and forming an impression. That is not a number you can regress
against: it drifts with mood, it cannot be compared across runs, and nothing
fails when a change makes discovery quietly worse.

So the rubric lives here, in code, with every target written down. Five
dimensions, weighted by what actually matters to a candidate:

    breadth   25%   how much of the world did it look at
    coverage  20%   did it look for the roles THIS person can do
    diversity 15%   how many different employers came back
    signal    25%   how much of it was real
    fit       15%   could they actually take the job

Each dimension scores 0-100 from sub-metrics that are ratios against a stated
target, so a score is always traceable to a count. `explain()` prints the whole
derivation — a grade nobody can audit is a grade nobody should trust.
"""
from __future__ import annotations

import re

WEIGHTS = {
    "breadth": 0.25,
    "coverage": 0.20,
    "diversity": 0.15,
    "signal": 0.25,
    "fit": 0.15,
}

# What "excellent" means, per sub-metric. Set from what the sources can actually
# deliver — a target nothing can reach makes the score a constant.
TARGETS = {
    "ats_vendors": 5,        # distinct ATS vendors returning an India internship
    "boards_polled": 200,    # company boards asked directly
    "web_queries": 60,       # searches issued
    "engines": 4,            # search engines that answered
    "role_angles": 12,       # distinct role queries derived from the candidate
    "distinct_companies": 25,
    "max_company_share": 0.15,  # no single employer above this share of results
    "fresh_days": 90,
}

_INDIA = re.compile(
    r"\b(india|bengaluru|bangalore|mumbai|delhi|ncr|gurgaon|gurugram|hyderabad|"
    r"pune|chennai|noida|kolkata|ahmedabad|jaipur|chandigarh|kochi|coimbatore|"
    r"indore|bhubaneswar|nagpur|vizag|visakhapatnam|thiruvananthapuram|mysuru|"
    r"mysore|remote)\b", re.I,
)


def _ratio(value: float, target: float) -> float:
    if target <= 0:
        return 0.0
    return max(0.0, min(1.0, value / target))


def _pct(part: int, whole: int) -> float:
    return (part / whole) if whole else 0.0


def _sub(name: str, value, target, points: float, weight: float) -> dict:
    return {
        "metric": name, "value": value, "target": target,
        "points": round(points, 1), "max": weight,
    }


def _breadth(rep: dict) -> tuple[float, list[dict]]:
    boards = rep.get("ats_boards") or []
    productive = {(b["vendor"], b["slug"]) for b in boards if b.get("india_internships")}
    vendors = {v for v, _ in productive}
    polled = {(b["vendor"], b["slug"]) for b in boards}
    queries = len(rep.get("web_queries") or [])
    engines = len(rep.get("engines_answering") or [])

    subs = [
        _sub("ATS vendors with a live India internship", len(vendors), TARGETS["ats_vendors"],
             _ratio(len(vendors), TARGETS["ats_vendors"]) * 30, 30),
        _sub("company boards polled", len(polled), TARGETS["boards_polled"],
             _ratio(len(polled), TARGETS["boards_polled"]) * 25, 25),
        _sub("web queries issued", queries, TARGETS["web_queries"],
             _ratio(queries, TARGETS["web_queries"]) * 25, 25),
        _sub("search engines answering", len(engines and rep["engines_answering"] or []),
             TARGETS["engines"], _ratio(engines, TARGETS["engines"]) * 20, 20),
    ]
    return sum(s["points"] for s in subs), subs


def _coverage(rep: dict) -> tuple[float, list[dict]]:
    domains = [d.lower() for d in (rep.get("plan", {}).get("domains") or [])]
    skills = [s.lower() for s in (rep.get("plan", {}).get("skills") or [])][:12]
    sets = rep.get("keyword_sets") or []
    asked = " ".join(" ".join(s).lower() for s in sets)
    # A domain counts as searched when its distinctive words appear in some
    # query — "web developement" is matched by "web development intern", and
    # demanding the exact string would report a miss on a typo the LLM fixed.
    def _covered(phrase: str) -> bool:
        words = [w for w in re.findall(r"[a-z]+", phrase) if len(w) > 2]
        if not words:
            return False
        return sum(1 for w in words if w[:5] in asked) >= max(1, len(words) - 1)

    dom_hit = sum(1 for d in domains if _covered(d))
    skill_hit = sum(1 for s in skills if _covered(s))
    angles = len(sets)

    subs = [
        _sub("stated domains searched", f"{dom_hit}/{len(domains)}", "all",
             _pct(dom_hit, len(domains)) * 40, 40),
        _sub("distinct role angles queried", angles, TARGETS["role_angles"],
             _ratio(angles, TARGETS["role_angles"]) * 35, 35),
        _sub("top skills represented in a query", f"{skill_hit}/{len(skills)}", "60%",
             min(1.0, _pct(skill_hit, len(skills)) / 0.6) * 25, 25),
    ]
    return sum(s["points"] for s in subs), subs


def _diversity(rep: dict) -> tuple[float, list[dict]]:
    listings = rep.get("listings") or []
    trusted = [l for l in listings if l.get("host_class") in ("ats", "employer")]
    names = [(l.get("company") or "?").strip().lower() for l in trusted]
    distinct = len(set(names))
    top_share = 0.0
    if names:
        top_share = max(names.count(n) for n in set(names)) / len(names)
    vendors = {l.get("vendor") for l in trusted if l.get("vendor")}

    # Concentration: full marks at or below the target share, zero at 3x it.
    # A run that found nothing scores zero rather than full marks — with no
    # listings the largest share is 0%, which is "perfectly diverse" only in the
    # arithmetic, and a broken run must never grade like a great one.
    tgt = TARGETS["max_company_share"]
    if not names:
        conc = 0.0
    elif top_share <= tgt:
        conc = 1.0
    else:
        conc = max(0.0, 1 - (top_share - tgt) / (2 * tgt))

    subs = [
        _sub("distinct employers (trusted only)", distinct, TARGETS["distinct_companies"],
             _ratio(distinct, TARGETS["distinct_companies"]) * 50, 50),
        _sub("largest single employer's share", f"{top_share:.0%}", f"<={tgt:.0%}",
             conc * 30, 30),
        _sub("distinct ATS vendors represented", len(vendors), TARGETS["ats_vendors"],
             _ratio(len(vendors), TARGETS["ats_vendors"]) * 20, 20),
    ]
    return sum(s["points"] for s in subs), subs


def _signal(rep: dict) -> tuple[float, list[dict]]:
    listings = rep.get("listings") or []
    n = len(listings)
    real = [l for l in listings if l.get("host_class") in ("ats", "employer")]
    trusted = len(real)
    # Description coverage is measured over the TRUSTED set: an aggregator page
    # is long and reads as well-described, so counting it here would let junk
    # earn back the marks the trust ratio just took away.
    described = sum(1 for l in real if (l.get("jd_chars") or 0) >= 600)
    keys = [l.get("canonical") or l.get("url") for l in listings]
    unique = len(set(keys))

    # Deliberately lopsided. Being real is most of what "signal" means — a run
    # that is two-thirds mirror sites should not reach a passing score on the
    # strength of tidy descriptions and no duplicates.
    subs = [
        _sub("on an employer-owned page", f"{trusted}/{n}", "100%",
             _pct(trusted, n) * 70, 70),
        _sub("trusted results with a real description", f"{described}/{trusted}", "100%",
             _pct(described, trusted) * 15, 15),
        _sub("distinct postings (no duplicates)", f"{unique}/{n}", "100%",
             _pct(unique, n) * 15, 15),
    ]
    return sum(s["points"] for s in subs), subs


def _fit(rep: dict) -> tuple[float, list[dict]]:
    listings = rep.get("listings") or []
    n = len(listings)
    located = sum(1 for l in listings if (l.get("location") or "").strip())
    in_india = sum(1 for l in listings if _INDIA.search(l.get("location") or ""))
    fresh = sum(1 for l in listings
                if isinstance(l.get("posted_days"), int)
                and l["posted_days"] <= TARGETS["fresh_days"])
    paid = sum(1 for l in listings if (l.get("stipend") or "").strip())

    subs = [
        _sub("location known", f"{located}/{n}", "100%", _pct(located, n) * 30, 30),
        _sub("located in India (or remote)", f"{in_india}/{n}", "100%",
             _pct(in_india, n) * 30, 30),
        _sub(f"posted within {TARGETS['fresh_days']}d", f"{fresh}/{n}", "100%",
             _pct(fresh, n) * 20, 20),
        _sub("stipend or duration known", f"{paid}/{n}", "100%", _pct(paid, n) * 20, 20),
    ]
    return sum(s["points"] for s in subs), subs


_DIMENSIONS = {
    "breadth": _breadth,
    "coverage": _coverage,
    "diversity": _diversity,
    "signal": _signal,
    "fit": _fit,
}


def score(rep: dict) -> dict:
    out: dict = {"dimensions": {}, "total": 0.0}
    total = 0.0
    for name, fn in _DIMENSIONS.items():
        points, subs = fn(rep)
        weight = WEIGHTS[name]
        total += points * weight
        out["dimensions"][name] = {
            "score": round(points, 1), "weight": weight,
            "weighted": round(points * weight, 2), "sub_metrics": subs,
        }
    out["total"] = round(total, 1)
    return out


def explain(rep: dict) -> str:
    s = score(rep)
    lines = ["", "=" * 74, "DISCOVERY SCORE", "=" * 74]
    for name, d in s["dimensions"].items():
        lines.append(f"\n{name.upper():<10} {d['score']:>5.1f}/100   "
                     f"weight {d['weight']:.0%}   -> {d['weighted']:.2f}")
        for sub in d["sub_metrics"]:
            lines.append(f"    {sub['metric']:<42} {str(sub['value']):>10}  "
                         f"(target {sub['target']})  {sub['points']:>5.1f}/{sub['max']}")
    lines.append("")
    lines.append("-" * 74)
    lines.append(f"TOTAL  {s['total']:.1f} / 100")
    lines.append("=" * 74)
    return "\n".join(lines)
