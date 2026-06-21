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


def _experience_penalty(title: str, exp_level: str | None) -> float:
    """Adjust score based on seniority vs candidate level (-0.15 to +0.05)."""
    if not exp_level:
        return 0.0
    low = title.lower()
    senior_kw = {"senior", "lead", "principal", "head", "manager", "director", "staff"}
    entry_kw = {"intern", "junior", "fresher", "trainee", "entry", "graduate"}
    is_senior = any(k in low for k in senior_kw)
    is_entry = any(k in low for k in entry_kw)
    if exp_level in ("student", "fresher"):
        if is_senior:
            return -0.15
        if is_entry:
            return +0.05
    elif exp_level == "1-2yr":
        if is_senior:
            return -0.05
    return 0.0


def score_job(
    job: dict,
    skills: list[str],
    domains: list[str],
    exp_level: str | None = None,
) -> tuple[int, str]:
    """Return (0-100, human reason)."""
    skills = [_alias(s) for s in skills]
    job_skills = [_alias(s) for s in (job.get("skills") or [])]
    haystack = " ".join(
        [_norm(job.get("title", "")), job.get("company", ""), " ".join(job_skills)]
    ).lower()
    hay_tokens = _tokens(haystack)

    if not skills:
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

    # 4) experience level adjustment
    base += _experience_penalty(job.get("title", ""), exp_level)

    score = int(round(min(1.0, max(0.0, base)) * 100))

    if hits:
        reason = "matches " + ", ".join(hits[:4])
    else:
        reason = "weak skill overlap"

    # transparent breakdown — surfaced verbatim in the dashboard so the user can
    # see *why* a job scored the way it did (and contest a bad match).
    parts = [f"{len(hits)}/{len(skills)} of your skills"]
    if job_skills:
        parts.append(f"{len(js_hits)}/{len(job_skills)} role skills")
    parts.append("domain ✓" if domain_hit else "domain ✗")
    exp_adj = _experience_penalty(job.get("title", ""), exp_level)
    if exp_adj > 0:
        parts.append("level fit ✓")
    elif exp_adj < 0:
        parts.append("level mismatch ✗")
    reason = f"{reason} · " + ", ".join(parts)
    return score, reason


def _fuzzy_company_match(company: str, excluded: str) -> bool:
    """Return True if excluded name looks like the same company as company."""
    c = company.lower().strip()
    e = excluded.lower().strip()
    if not e:
        return False
    # exact substring match in either direction
    if e in c or c in e:
        return True
    # first-word match (e.g. "Acme" matches "Acme Corp Ltd")
    c_words = c.split()
    e_words = e.split()
    if c_words and e_words and c_words[0] == e_words[0]:
        return True
    return False


def firewall_block(job: dict, profile: dict) -> str | None:
    """Return a block reason if a hard constraint forbids applying, else None."""
    excluded = _json_list(profile.get("excluded_companies"))
    company = job.get("company", "")
    if any(_fuzzy_company_match(company, e) for e in excluded):
        return f"excluded company {company}"

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
    return min(vals) if vals else None
