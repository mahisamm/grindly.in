"""Scam-gate Layer 2: company reputation check (LLM-first, cached).

Layer 1 (scam.py) catches listings that spell out a money demand in their text.
Layer 2 asks a different question — is the *company itself* a known trap? — for
listings that already passed L1 and are about to be queued. An ensemble of models
judges the company + JD against a strict fraud rubric, and the verdict is cached
per company (30-day TTL) so the same lookup is never paid for twice.

Conservative by construction — a false "scam" verdict silently robs a student of
a real opportunity, so:
  * No LLM providers configured, or all of them fail  -> check_company returns
    None. Reputation is unknown and NOTHING is blocked; L1 is the safety floor.
  * The ensemble merges the boolean is_scam by majority with ties resolving to
    False (llm._merge_values), so one model's guess can't condemn a company.
  * Only a high-confidence scam verdict is meant to block; caution/ok still queue.
"""
from __future__ import annotations
import re

import db
import llm as llm_mod

# A company's reputation is re-checked at most this often.
_TTL_MS = 30 * 24 * 60 * 60 * 1000

VERDICT_OK = "ok"
VERDICT_CAUTION = "caution"
VERDICT_SCAM = "scam"

# Only true legal-form suffixes are stripped for the cache key — NOT descriptive
# words like "technologies"/"solutions", so "Bright Labs" and "Bright Services"
# stay distinct companies rather than colliding on one cached verdict.
_LEGAL_SUFFIX = re.compile(
    r"\b(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|incorporated|"
    r"corp\.?|corporation|co\.?)\b", re.I)


def normalize(company: str) -> str:
    """Lowercased, trimmed, legal-suffix-stripped company name — the cache key.
    'Acme Corp Pvt. Ltd.' and 'acme corp' both collapse to 'acme corp'."""
    s = (company or "").lower()
    s = re.sub(r"[^a-z0-9&\s]", " ", s)
    s = _LEGAL_SUFFIX.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()


_SYSTEM = (
    "You are a fraud analyst protecting students from internship scams in India. "
    "Judge ONLY whether a company/listing shows a concrete, known scam signal: "
    "charging the applicant any fee/deposit/'training' payment, pay-to-get-"
    "certificate, MLM / network-marketing, fake-company data-harvesting, or "
    "unrealistic guaranteed earnings. A normal company you simply don't recognize "
    "is NOT a scam — absence of evidence is 'ok', never 'scam'. When unsure, say "
    "it is not a scam."
)


def _prompt(company: str, jd_text: str) -> str:
    jd = (jd_text or "").strip()[:1500]
    return (
        f"Company: {company}\n"
        f"Listing text:\n{jd or '(no description available)'}\n\n"
        'Return ONLY JSON: {"is_scam": true|false, "confidence": 0.0-1.0, '
        '"reason": "<=12 words"}. Set is_scam=true ONLY for a concrete scam '
        "signal from the list above; otherwise false."
    )


def _valid(obj) -> bool:
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("is_scam"), bool)
        and isinstance(obj.get("confidence"), (int, float))
        and not isinstance(obj.get("confidence"), bool)
    )


def check_company(company: str, jd_text: str = "", block_threshold: float = 0.7) -> dict | None:
    """Return {"verdict", "confidence", "evidence", "cached"} for a company, or
    None when reputation can't be determined (no LLM / all providers failed).
    Verdict is one of ok | caution | scam. Cached per normalized company for the
    TTL; callers should hard-block only on verdict == scam.
    """
    norm = normalize(company)
    if not norm:
        return None

    cached = db.get_company_reputation(norm, max_age_ms=_TTL_MS)
    if cached:
        return {
            "verdict": cached.get("verdict") or VERDICT_OK,
            "confidence": float(cached.get("confidence") or 0.0),
            "evidence": cached.get("evidence"),
            "cached": True,
        }

    obj = llm_mod.chat_json_ensemble(
        _prompt(company, jd_text), system=_SYSTEM, n=3, timeout=45, validator=_valid
    )
    if obj is None:
        return None  # unknown — never block on a missing signal

    is_scam = bool(obj.get("is_scam"))
    confidence = float(obj.get("confidence") or 0.0)
    reason = str(obj.get("reason") or "").strip()[:140]
    if is_scam and confidence >= block_threshold:
        verdict = VERDICT_SCAM
    elif is_scam:
        verdict = VERDICT_CAUTION
    else:
        verdict = VERDICT_OK

    # A verdict from ONE provider is not a consensus. chat_json_ensemble falls
    # back to returning that single answer verbatim when the others fail or time
    # out, bypassing the merge this check is named for — and this cache is keyed
    # by company name and shared by the whole fleet, so a single hallucinated
    # "is_scam" would block that employer for every user until the TTL expired.
    #
    # Downgrade a lone SCAM verdict to CAUTION, which records the signal without
    # blocking anyone, and leave it out of the cache so the next run asks again.
    single = bool(llm_mod.last_ensemble_was_degraded())
    if single and verdict == VERDICT_SCAM:
        print(f"[company_rep] {norm}: lone-provider scam verdict downgraded to caution (not cached)")
        return {
            "verdict": VERDICT_CAUTION, "confidence": confidence,
            "evidence": reason, "cached": False,
        }

    db.set_company_reputation(norm, verdict, confidence, evidence=reason, source="llm")
    return {"verdict": verdict, "confidence": confidence, "evidence": reason, "cached": False}
