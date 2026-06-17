"""Score a listing against the candidate's skills, and apply the firewall
constraints from their profile. Deterministic + free; the score IS the
threshold the user set in onboarding (min_match_score)."""
from __future__ import annotations
import json
import re


# normalize skill spellings so equivalents match (node.js == nodejs == node)
_ALIAS = {
    "node.js": "node", "nodejs": "node", "node js": "node",
    "next.js": "nextjs", "reactjs": "react", "react.js": "react",
    "react native": "reactnative", "rest api": "restapi",
    "scikit-learn": "sklearn", "ui/ux": "uiux", "power bi": "powerbi",
}


def _alias(s: str) -> str:
    s = s.strip().lower()
    return _ALIAS.get(s, s)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9+./ ]", " ", (s or "").lower())


def _tokens(s: str) -> set[str]:
    return {t for t in _norm(s).split() if len(t) > 1}


def score_job(job: dict, skills: list[str], domains: list[str]) -> tuple[int, str]:
    """Return (0-100, human reason)."""
    skills = [_alias(s) for s in skills]
    job_skills = [_alias(s) for s in (job.get("skills") or [])]
    haystack = " ".join(
        [_norm(job.get("title", "")), job.get("company", ""), " ".join(job_skills)]
    ).lower()
    hay_tokens = _tokens(haystack)

    if not skills:
        # no resume signal yet → neutral-ish so user still sees activity
        return 50, "no skills extracted yet; neutral score"

    # 1) direct skill hits (substring OR token)
    hits = []
    for sk in skills:
        if sk in haystack or hay_tokens & _tokens(sk):
            hits.append(sk)
    overlap = len(hits) / max(1, len(skills))

    # 2) explicit job-skill overlap (stronger signal)
    js_hits = [s for s in job_skills if s in skills or _tokens(s) & set(skills)]
    js_ratio = len(js_hits) / max(1, len(job_skills)) if job_skills else 0

    # 3) domain alignment
    domain_hit = any(_tokens(d) & hay_tokens for d in domains) if domains else False

    base = 0.55 * min(1.0, overlap * 1.8) + 0.35 * js_ratio
    if domain_hit:
        base += 0.10
    score = int(round(min(1.0, base) * 100))

    if hits:
        reason = "matches " + ", ".join(hits[:4])
        if domain_hit:
            reason += " (+domain)"
    else:
        reason = "weak skill overlap"
    return score, reason


def firewall_block(job: dict, profile: dict) -> str | None:
    """Return a block reason if a hard constraint forbids applying, else None."""
    excluded = _json_list(profile.get("excluded_companies"))
    if any(job.get("company", "").lower() == e.lower() for e in excluded):
        return f"excluded company {job.get('company')}"

    work_mode = profile.get("work_mode") or "any"
    loc = (job.get("location") or "").lower()
    if work_mode == "remote" and "remote" not in loc and "work from home" not in loc:
        return "not remote"
    if work_mode == "onsite" and ("remote" in loc or "work from home" in loc):
        return "remote, wanted onsite"

    stipend_min = int(profile.get("stipend_min") or 0)
    if stipend_min > 0:
        amt = _parse_stipend(job.get("stipend"))
        if amt is not None and amt < stipend_min:
            return f"stipend ₹{amt} < min ₹{stipend_min}"

    return None


def _json_list(v) -> list[str]:
    if not v:
        return []
    try:
        return json.loads(v) if isinstance(v, str) else list(v)
    except Exception:  # noqa: BLE001
        return []


def _parse_stipend(s) -> int | None:
    if not s:
        return None
    nums = re.findall(r"\d[\d,]*", str(s))
    if not nums:
        return None
    vals = [int(n.replace(",", "")) for n in nums]
    # listings often show a range; use the low end
    return min(vals) if vals else None
