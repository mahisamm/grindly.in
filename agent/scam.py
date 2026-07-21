"""Deterministic scam / pay-to-intern red-flag scanner.

Layer 1 of the scam gate. Runs on every listing right after the profile firewall
and before anything is queued. Free and instant: it reads the job text for the
one thing a legitimate internship never does — ask the *student* to hand over
money (registration fee, security deposit, "pay for training", buy a starter
kit) — plus the classic MLM / "earn ₹50k a week from home" earnings tells.

The student problem this solves: fake "companies" that accept you, then ask for
a fee, deposit, or "training charge" before the internship or the promised
project. A real employer pays you; it never bills you to start.

Design rule: PRECISION over recall. A false block silently robs a student of a
real opportunity, so every pattern requires payment *context* and *direction* —
never the bare word "fee" or "deposit", and never "we pay you". "Paid
internship", "stipend of ₹10,000/month", and "salary credited to your account"
must never trip it. Softer, name-based reputation checks (Reddit / LLM) are
Layer 2 and live in company_rep.py.
"""
from __future__ import annotations
import re

# A rupee/dollar amount, e.g. "₹500", "Rs. 1,000", "INR 2000". Used to anchor the
# high-precision "quotes a fee you must pay" patterns.
_AMT = r"(?:₹|rs\.?|inr|rupees?|\$)\s?[\d,]+"

# The applicant, named — used to catch "candidates have to pay ...".
_APPLICANT = r"(?:you|candidate|candidates|student|students|intern|interns|applicant|applicants|selected)"

# Each entry: (compiled pattern, short human reason). First match wins. Patterns
# run against a lowercased blob of the listing's title, declared skills, and JD.
# Ordering is by how unambiguous the tell is.
_HARD_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # ── the applicant is billed a fee / deposit to apply, join, or train ──
    # A scam-context noun immediately followed by a payment noun: "registration
    # fee", "security deposit", "training charges", "refundable amount", "joining
    # fee", "caution money", "kit cost". Order matters (context THEN payment word),
    # so "payment processing" or "we deposit your salary" don't match.
    (re.compile(
        r"\b(registration|regis|application|processing|enroll?ment|onboarding|joining|"
        r"admission|training|course|certification|certificate|kit|starter[-\s]?kit|"
        r"material|security|caution|refundable)\b[\s\-\w]{0,12}?\b"
        r"(fee|fees|charge|charges|deposit|money|cost)\b"),
     "asks for an upfront fee or deposit"),

    # A concrete amount attached to a fee/deposit: "fee of ₹500", "deposit of
    # Rs 1000", "₹299 registration".
    (re.compile(r"\b(fee|fees|charge|charges|deposit|amount)\s+of\s+" + _AMT),
     "quotes a fee/deposit you must pay"),
    (re.compile(_AMT + r"\s+(?:registration|joining|security|refundable|training)\b"),
     "quotes a fee/deposit you must pay"),

    # Direct demands: "have to pay", "need to pay", "pay a fee", "pay the deposit".
    # A bare "pay ₹500" is deliberately NOT matched here — "we pay ₹15000/month" is
    # a legitimate stipend and points the other way; only "pay" + a scam-context
    # word (fee/deposit/registration) is unambiguous. Amounts are caught by the
    # "fee of ₹X" / "₹X registration" / "have to pay" patterns instead.
    (re.compile(r"\b(?:have|has|need|needs|required|must|should)\s+to\s+pay\b"),
     "requires the candidate to pay money"),
    (re.compile(r"\bpay\s+(?:a\s+|the\s+|an\s+)?(?:fee|fees|charge|charges|deposit|registration)\b"),
     "asks you to pay a fee to start"),
    (re.compile(_APPLICANT + r"\b[\s\-\w]{0,20}?\bpay\b[\s\-\w]{0,12}?\b(?:fee|fees|deposit|charges?|registration)\b"),
     "requires the candidate to pay money"),

    # "pay to apply / join / register / confirm / activate / get started ..."
    (re.compile(r"\bpay\b[\s\-\w]{0,15}?\bto\s+(?:apply|join|register|start|begin|enrol|"
                r"get\s+started|receive|claim|unlock|proceed|continue|confirm|activate|"
                r"access|be\s+shortlisted)\b"),
     "asks you to pay to apply or join"),

    # An upfront "investment" / "one-time payment" framed as a requirement.
    (re.compile(r"\b(?:one[-\s]?time|upfront|initial|small)\s+(?:payment|fee|charges?|investment)\b"),
     "asks for an upfront payment or 'investment'"),

    # Pay a fee via a personal wallet — never how a real employer onboards.
    # Requires BOTH a wallet name AND a fee/amount word, so "salary via UPI"
    # (no fee word) does not match.
    (re.compile(r"\b(?:pay|send|transfer|deposit)\b[\s\-\w]{0,25}?"
                r"\b(?:upi|paytm|phonepe|phone\s?pe|g[-\s]?pay|google\s?pay|"
                r"bank\s+account)\b[\s\-\w]{0,25}?\b(?:fee|amount|deposit|charges?|registration|" + _AMT + r")\b"),
     "asks you to pay a fee via UPI/wallet transfer"),

    # ── MLM / unrealistic earnings ──
    # "earn ₹5000 per day / a week" — legit monthly stipends are NOT matched.
    (re.compile(r"\bearn\b[\s\-\w]{0,20}?" + _AMT + r"[\s\-\w]{0,8}?\b(?:per\s+day|/\s?day|a\s+day|"
                r"per\s+week|/\s?week|a\s+week|daily|weekly)\b"),
     "promises unrealistic daily/weekly earnings"),
    # Recruit-your-own-team commission structures dressed up as an internship.
    (re.compile(r"\b(?:recruit|refer|add|enrol)\b[\s\-\w]{0,20}?\b(?:members?|people|others?|friends?|candidates?)\b"
                r"[\s\-\w]{0,20}?\b(?:commission|earn|bonus|incentive|income|per\s+head)\b"),
     "pay-per-recruit / MLM referral scheme"),
    # "build your own team ... income" — a co-signal is required so a legitimate
    # team-lead role ("build your team of engineers") is not misread as MLM.
    (re.compile(r"\b(?:build|grow|create)\s+your\s+own\s+(?:team|downline)\b[\s\-\w]{0,80}?"
                r"\b(?:income|earn|commission|recruit|joining)\b"),
     "network-marketing / MLM structure, not a real internship"),
]


# A legitimate listing sometimes REASSURES ("no registration fee", "joining fee
# waived", "we never ask for any deposit", "100% free") — the scam word is present
# but negated. We must not block those. Three checks, tuned so a nearby *unrelated*
# "no" (e.g. "no experience needed. Registration fee ₹500") does NOT count:
#   * _NEG_ADJACENT — a bare negator right before the phrase ("no registration fee")
#   * _NEG_DEMAND   — a negated demand verb before it ("never ask for", "don't charge")
#   * _NEG_AFTER    — the phrase is cancelled just after ("... fee waived")
_NEG_ADJACENT = re.compile(r"\b(?:no|without|zero|nil|free|exempt|waived?)\s*$")
_NEG_DEMAND = re.compile(
    r"\b(?:never|not|no|don'?t|do\s+not|won'?t|will\s+not|dont)\b(?:\s+\w+){0,3}?\s+"
    r"(?:ask(?:ing)?|charg\w+|require\w*|demand\w*|collect\w*|take|taking|takes)\b")
_NEG_AFTER = re.compile(r"^\s*\w*\s*(?:waived?|not\s+required|exempt|free\s+of)\b")


def _blob(job: dict, jd_text: str) -> str:
    """Lowercased text to scan: title + declared skills + JD. Company name is left
    out on purpose — scam demands live in the description, and fintech employer
    names ("Razorpay", "PayU", "Paytm") should never seed a false positive."""
    parts: list[str] = [str(job.get("title") or "")]
    skills = job.get("skills") or []
    if isinstance(skills, (list, tuple)):
        parts.append(" ".join(str(s) for s in skills))
    else:
        parts.append(str(skills))
    if jd_text:
        parts.append(str(jd_text))
    return " ".join(parts).lower()


def scam_block(job: dict, jd_text: str = "") -> str | None:
    """Return a short reason string if this listing shows a hard scam red flag
    (the applicant is asked to pay, or it's an MLM/earnings trap), else None.

    Conservative by design — only fires on an explicit money-demand or an
    unmistakable earnings scam. When the JD text is empty there is usually
    nothing to catch, and that's fine: L1 never blocks on a hunch.
    """
    blob = _blob(job, jd_text)
    if not blob.strip():
        return None
    for pat, reason in _HARD_PATTERNS:
        for m in pat.finditer(blob):
            adjacent = blob[max(0, m.start() - 8):m.start()]
            window = blob[max(0, m.start() - 48):m.start()]
            after = blob[m.end():m.end() + 16]
            if _NEG_ADJACENT.search(adjacent) or _NEG_DEMAND.search(window) or _NEG_AFTER.search(after):
                continue  # negated reassurance ("no fee", "never ask for", "waived")
            return reason
    return None
