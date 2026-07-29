"""How well can the agent APPLY, unattended, to what it finds? 0-100, explainable.

`discovery_score` grades the first half of the product: did the agent find real,
fresh, varied internships. This grades the second half, which is the half the
user actually pays for: of the postings it found, how many can it complete on
its own, with nobody watching and nobody clicking.

The two halves fail in completely different ways, so they need separate rubrics.
A run can find 60 excellent postings and submit none of them (every one on a
board that holds the user's account), and discovery_score would call that a 93.

Design rules, same as discovery_score:

  * Every sub-metric is a RATIO against a stated target, so a number can be
    argued with rather than believed.
  * Nothing is graded that the agent does not control. Whether an employer's
    ATS shows a human-check to a datacenter IP is the agent's problem to route
    around; whether an employer asks for a transcript upload is not, and a
    listing stopped there is counted as correctly refused, not as a failure.
  * A broken run must not grade like a great one. Zero probed listings scores
    zero on every measured dimension rather than dividing by zero into 1.0.

Segments
--------
routing        of the postings that are genuinely employer-owned, how many did
               we resolve to a destination we may submit to unattended
deliverability of those destinations, how many have a sender that exists AND is
               switched on right now
fillability    of the destinations we dry-ran, how many reached "everything is
               filled, the submit button is under the cursor" without a human
safety         did anything get answered that we do not actually know, and was
               the no-submit invariant of the dry run held
confirmation   after a real submit, would we be able to tell that it worked
spread         are the submittable listings spread across the user's capability
               clusters, or all one kind of role

The input is an `apply_probe` report. Read `explain()` for the arithmetic behind
any number here — no dimension is allowed to be a judgement call.
"""
from __future__ import annotations

WEIGHTS = {
    "routing": 0.25,
    "deliverability": 0.20,
    "fillability": 0.25,
    "safety": 0.15,
    "confirmation": 0.10,
    "spread": 0.05,
}

# What "full marks" means, written down rather than implied.
TARGETS = {
    # Share of employer-owned postings (hosts.classify in ats/employer) that end
    # up on a Tier A destination with a real target URL.
    "routing": 0.95,
    # Share of Tier A destinations whose channel has an enabled sender.
    "deliverability": 0.95,
    # Share of dry runs that reached submit-ready.
    "fillability": 0.90,
    # Share of vendors in the mix that have a specific success signal.
    "confirmation": 0.90,
    # Share of the user's capability clusters represented among submittable
    # listings. Six is a normal résumé's worth of distinct directions.
    "clusters": 6,
}


def _ratio(value: float, target: float) -> float:
    if target <= 0:
        return 0.0
    return max(0.0, min(1.0, value / target))


def _pct(part: int, whole: int) -> float:
    return (part / whole) if whole else 0.0


def _routing(rep: dict) -> tuple[float, dict]:
    """Of the postings that are really an employer's, how many are submittable?

    The denominator deliberately EXCLUDES junk. A run that finds 40 aggregator
    mirrors and discards all 40 has done its job perfectly, and counting those as
    failed conversions would grade the agent on the internet's behaviour instead
    of its own. Those are reported separately as `discarded`.
    """
    rows = rep.get("listings") or []
    convertible = [r for r in rows if r.get("host_class") in ("ats", "employer")]
    submittable = [r for r in convertible if r.get("tier") == "A" and r.get("target")]
    share = _pct(len(submittable), len(convertible))
    return _ratio(share, TARGETS["routing"]), {
        "employer_owned": len(convertible),
        "tier_a_with_target": len(submittable),
        "share": round(share, 3),
        "discarded_not_employer": len(rows) - len(convertible),
        "target": TARGETS["routing"],
    }


def _deliverability(rep: dict) -> tuple[float, dict]:
    rows = [r for r in (rep.get("listings") or []) if r.get("tier") == "A" and r.get("target")]
    live = [r for r in rows if r.get("deliverable")]
    share = _pct(len(live), len(rows))
    by_channel: dict[str, int] = {}
    for r in rows:
        if not r.get("deliverable"):
            by_channel[r.get("channel") or "?"] = by_channel.get(r.get("channel") or "?", 0) + 1
    return _ratio(share, TARGETS["deliverability"]), {
        "tier_a": len(rows),
        "with_live_sender": len(live),
        "share": round(share, 3),
        "undeliverable_by_channel": by_channel,
        "target": TARGETS["deliverability"],
    }


def _fillability(rep: dict) -> tuple[float, dict]:
    """Did the dry run get all the way to the submit button?

    A listing the agent correctly REFUSED (the role closed between discovery and
    the dry run) is not a fillability failure — the outcome was right. It is
    dropped from the denominator, and reported, so a run cannot quietly improve
    its score by finding more dead links.
    """
    runs = [r for r in (rep.get("listings") or []) if r.get("dry_run")]
    graded = [r for r in runs if (r["dry_run"].get("outcome") != "closed")]
    ready = [r for r in graded if r["dry_run"].get("outcome") == "submit_ready"]
    stops: dict[str, int] = {}
    for r in graded:
        outcome = r["dry_run"].get("outcome") or "?"
        if outcome != "submit_ready":
            stops[outcome] = stops.get(outcome, 0) + 1
    share = _pct(len(ready), len(graded))
    return _ratio(share, TARGETS["fillability"]), {
        "dry_runs": len(runs),
        "graded": len(graded),
        "submit_ready": len(ready),
        "share": round(share, 3),
        "stopped_at": stops,
        "closed_listings_excluded": len(runs) - len(graded),
        "target": TARGETS["fillability"],
    }


def _safety(rep: dict) -> tuple[float, dict]:
    """Two invariants, both absolute: nothing invented, nothing submitted.

    Scored as a product rather than a mean — a probe that clicked a submit
    button is not 50% safe, it is broken, and averaging would hide that behind
    a good answer-provenance number.
    """
    runs = [r["dry_run"] for r in (rep.get("listings") or []) if r.get("dry_run")]
    invented = sum(int(d.get("invented_answers") or 0) for d in runs)
    answered = sum(int(d.get("answers_total") or 0) for d in runs)
    submits = sum(int(bool(d.get("submitted"))) for d in runs)

    honest = 1.0 if not answered else max(0.0, 1.0 - (invented / answered))
    no_submit = 0.0 if submits else 1.0
    return honest * no_submit, {
        "answers_written": answered,
        "answers_not_backed_by_a_known_fact": invented,
        "submits_clicked_by_the_probe": submits,
        "honest_answer_share": round(honest, 3),
    }


def _confirmation(rep: dict) -> tuple[float, dict]:
    """After a real submit, could we tell it worked?

    Measured over the vendor mix actually present, not over the vendors we have
    written selectors for — a perfect Greenhouse confirmation is worth nothing
    on a run that found only Lever postings.
    """
    rows = [r for r in (rep.get("listings") or []) if r.get("tier") == "A" and r.get("target")]
    known = [r for r in rows if r.get("confirmation_known")]
    share = _pct(len(known), len(rows))
    missing = sorted({
        (r.get("vendor") or r.get("channel") or "?")
        for r in rows if not r.get("confirmation_known")
    })
    return _ratio(share, TARGETS["confirmation"]), {
        "tier_a": len(rows),
        "with_a_specific_success_signal": len(known),
        "share": round(share, 3),
        "vendors_without_one": missing,
        "target": TARGETS["confirmation"],
    }


def _spread(rep: dict) -> tuple[float, dict]:
    """Submittable listings across the user's capability clusters.

    Deliberately measured on the SUBMITTABLE set, not on everything found.
    Discovery already grades breadth; the question here is whether the half of
    the product that actually applies is stuck in one domain.
    """
    import rolequeries

    rows = [r for r in (rep.get("listings") or []) if r.get("tier") == "A" and r.get("target")]
    hit: set[str] = set()
    for r in rows:
        blob = f"{r.get('title', '')} {' '.join(r.get('skills') or [])}".lower()
        # _FALLBACK entries are (skill triggers, role titles). A listing belongs
        # to a cluster when either side of that pair shows up in it — the title
        # names the role, the extracted skills name the capability, and a run
        # that matched only on titles would under-count every backend posting
        # that calls itself "SDE Intern".
        for triggers, roles in rolequeries._FALLBACK:
            if any(t in blob for t in triggers) or any(role in blob for role in roles):
                hit.add(roles[0])
    return _ratio(len(hit), TARGETS["clusters"]), {
        "clusters_represented": sorted(hit),
        "count": len(hit),
        "target": TARGETS["clusters"],
    }


_DIMENSIONS = {
    "routing": _routing,
    "deliverability": _deliverability,
    "fillability": _fillability,
    "safety": _safety,
    "confirmation": _confirmation,
    "spread": _spread,
}


def score(rep: dict) -> dict:
    """{total, dimensions:{name:{score, weight, detail}}} — 0-100."""
    out: dict[str, dict] = {}
    total = 0.0
    for name, fn in _DIMENSIONS.items():
        raw, detail = fn(rep)
        weight = WEIGHTS[name]
        out[name] = {
            "score": round(raw * 100, 1),
            "weight": weight,
            "detail": detail,
        }
        total += raw * weight
    return {"total": round(total * 100, 1), "dimensions": out}


def explain(graded: dict) -> str:
    lines = [f"APPLY SCORE  {graded['total']}/100", ""]
    for name, d in graded["dimensions"].items():
        lines.append(f"  {name:<14} {d['score']:>5.1f}  x{d['weight']:.2f}")
        for k, v in d["detail"].items():
            lines.append(f"      {k}: {v}")
        lines.append("")
    return "\n".join(lines)
