"""Targeting a company that is not in the curated list.

`companies.py` holds hand-curated packs: every claim in one was read off the
employer's own published page by a person, and carries the URL and the date they
read it. That is the strong version of this feature and it does not scale — there
are a few million employers and a couple of dozen packs.

This module is the weak version, and the whole design problem is being honest
about the difference. A user types "Freshworks" or "Zetwerk" or the name of a
forty-person startup, and there are three possible truthful answers:

  CURATED       We have a hand-checked pack. Use it. (Handled by `companies`.)

  GENERATED     The company is large and well-documented enough that a model
                has real knowledge of how it hires — a published interview
                process, a named engineering stack, a stated set of values. The
                emphasis we produce is a summary of that knowledge, it carries
                no citations, and it is labelled as generated everywhere it is
                shown. It is a starting point, not a source.

  NOT REQUIRED  We do not have anything specific and checkable about how this
                company screens. This is the common case and it is a real
                answer, not a failure: at a company of forty people the resume
                is read by a human being — often the founder — and there is no
                keyword filter to tune for. Inventing "Acme values ownership and
                customer obsession" for a company we know nothing about would be
                generating plausible text with nothing behind it, which is the
                exact failure mode this product exists to not have.

The bar for GENERATED is deliberately high and is enforced twice: the prompt
tells the model to decline, and `_verdict` overrides it to NOT REQUIRED whenever
the answer comes back thin, hedged, or generic. A model asked "how does company
X hire" will always produce fluent text; the job here is to throw most of it
away.

LEGAL SHAPE, same as `companies.py`: nothing is scraped, no crawler exists, and
naming an employer to identify the job someone is applying to is nominative use.
We claim no affiliation and no endorsement, and the disclaimer rides on every
response.
"""
from __future__ import annotations

import re

import companies
import llm as llm_mod

# Companies this small do not screen by keyword, and a model's "knowledge" of
# them is almost always a plausible-sounding blend of every startup it has read
# about. Below this confidence we decline rather than guess.
_MIN_CONFIDENCE = 0.55

# Emphasis lines have to survive the same rule the curated packs follow: they
# may say what to SURFACE, never what to CLAIM. A generated line telling a
# rewrite to "highlight your leadership of large distributed teams" is an
# instruction to fabricate for anyone who has not led one — the gates in
# resume_optimize would strip the result, but the variant is wasted and the
# user is told their resume is missing something we made up.
_CLAIM_INSTRUCTION_RE = re.compile(
    r"\b(?:add|include|insert|claim|state\s+that\s+you|say\s+that\s+you|"
    r"mention\s+that\s+you\s+have|if\s+you\s+don'?t\s+have)\b", re.I,
)

# Text that means the model is padding rather than reporting. Any emphasis line
# that is only this is dropped; a pack that is only these is declined.
_GENERIC_RE = re.compile(
    r"^\s*(?:tailor|customi[sz]e|highlight\s+relevant|use\s+keywords|"
    r"research\s+the\s+company|show\s+(?:your\s+)?passion|be\s+concise|"
    r"quantify\s+(?:your\s+)?achievements?|proofread)\b", re.I,
)

DISCLAIMER_GENERATED = (
    "This one is not curated. Grindly's company packs are ones where a person read "
    "the employer's own published pages and linked them; this is not one of "
    "those. What you see below is a language model's summary of publicly "
    "discussed hiring practice, with no citation behind it and no verification "
    "against anything the company has actually published. Treat it as a "
    "starting point and check the role's own posting. Grindly is not "
    "affiliated with, endorsed by, or partnered with this company."
)

NOT_REQUIRED_NOTE = (
    "We don't have anything specific and checkable about how {name} screens "
    "resumes, and we would rather say so than invent it. That is usually good "
    "news: at a company this size your resume is read by a person — often the "
    "founder or the hiring manager — not filtered by keyword first, so the "
    "general rebuild is already tuned for the reader you actually have. If you "
    "have their job posting, or you know something about them first-hand, use "
    "the box below — either is better evidence than anything we could have told "
    "you about the company."
)

_SYSTEM = (
    "You report what is publicly and widely known about how a named employer "
    "hires. You are not a marketing writer and you are not helpful when you "
    "guess. Declining is the correct answer far more often than not."
)

_PROMPT = """Company: {name}
{role_line}
Do you have specific, widely-published knowledge of how THIS company hires and
what its job postings ask for? Not general resume advice — knowledge about this
employer in particular: a published interview process, a stated set of values it
screens against, an engineering stack its postings name, an assessment it runs.

Answer with JSON only:

{{
  "known": true | false,
  "confidence": 0.0-1.0,
  "canonical_name": "the company's usual full name, or the input unchanged",
  "what_they_do": "one factual sentence, or empty",
  "size": "startup" | "mid" | "large" | "unknown",
  "summary": "one sentence on how this company screens, or empty",
  "emphasis": ["instruction on what an applicant should SURFACE from their own resume"],
  "keywords": ["vocabulary this employer's own postings use"]
}}

Rules, and they matter more than being useful:
- "known": false whenever you are working from the company's name, its industry,
  or what companies like it usually do. A private company under ~500 people is
  almost always false. If you are recalling this employer specifically, true.
- Never invent an interview process, a value set, a tech stack, or an assessment.
- "emphasis" tells someone which of their OWN experiences to lead with and how
  to word it. It never tells them to add, claim, or mention something they do
  not have. Maximum 4 lines. No generic resume advice.
- "keywords" are words that appear in this employer's postings. Maximum 12.
  Empty if you are not recalling real postings.
- Return {{"known": false, "confidence": 0.0}} rather than a plausible guess."""


def _validator(data) -> bool:
    return isinstance(data, dict) and "known" in data


def _clean_lines(raw, limit: int, max_chars: int = 240) -> list[str]:
    out: list[str] = []
    for value in raw if isinstance(raw, list) else []:
        line = re.sub(r"\s+", " ", str(value or "")).strip(" -•\t")
        if not line or len(line) < 12 or len(line) > max_chars:
            continue
        if _CLAIM_INSTRUCTION_RE.search(line) or _GENERIC_RE.match(line):
            continue
        if line.lower() in {o.lower() for o in out}:
            continue
        out.append(line)
        if len(out) >= limit:
            break
    return out


def _clean_keywords(raw, limit: int = 12) -> list[str]:
    out: list[str] = []
    for value in raw if isinstance(raw, list) else []:
        word = re.sub(r"\s+", " ", str(value or "")).strip().lower()
        # A "keyword" longer than four words is a sentence, and one shorter than
        # two characters matches everything.
        if not (2 <= len(word) <= 40) or len(word.split()) > 4:
            continue
        if word not in out:
            out.append(word)
        if len(out) >= limit:
            break
    return out


def _verdict(data: dict, name: str) -> dict:
    """Turn a model answer into one of the three truthful outcomes."""
    emphasis = _clean_lines(data.get("emphasis"), limit=4)
    keywords = _clean_keywords(data.get("keywords"))
    summary = re.sub(r"\s+", " ", str(data.get("summary") or "")).strip()
    try:
        confidence = float(data.get("confidence") or 0)
    except (TypeError, ValueError):
        confidence = 0.0

    # The name we print back. The model corrects spelling, so someone who typed
    # "telsa" is answered about Tesla, Inc. — including in the decline, which
    # used the raw input and produced a card headed "Tesla, Inc." above a
    # sentence about how "telsa" screens resumes.
    display = str(data.get("canonical_name") or name).strip()[:120] or name

    # Every one of these is a reason to decline, and they are checked
    # independently of what the model said about itself. A model that answers
    # "known": true and then produces two generic lines and no vocabulary has
    # told us it does not know, whatever the flag says.
    declined = (
        not bool(data.get("known"))
        or confidence < _MIN_CONFIDENCE
        or len(emphasis) < 2
        or not keywords
        or len(summary) < 20
    )
    if declined:
        return {
            "tailoring": "not_required",
            "name": display,
            "note": NOT_REQUIRED_NOTE.format(name=display),
            "emphasis": [],
            "keywords": [],
            "summary": "",
            "confidence": round(confidence, 2),
        }

    return {
        "tailoring": "generated",
        "name": display,
        "summary": summary[:400],
        "emphasis": emphasis,
        "keywords": keywords,
        "confidence": round(confidence, 2),
        "size": str(data.get("size") or "unknown")[:20],
        "note": DISCLAIMER_GENERATED,
    }


def research(name: str, role_hint: str = "") -> dict:
    """What we can honestly say about tailoring a resume to `name`.

    Always returns a dict with `tailoring` set to one of "curated",
    "generated" or "not_required", plus the disclaimer that belongs to that
    kind. Never raises: a research step that fails is a research step that
    declines, and declining is already one of the supported answers.
    """
    typed = re.sub(r"\s+", " ", str(name or "")).strip()
    if not typed:
        return {"ok": False, "error": "Type a company name."}
    if len(typed) > 80:
        return {"ok": False, "error": "That does not look like a company name."}

    # A curated pack always wins, including on a near-miss spelling of one.
    for pack in companies.PACKS:
        low = typed.lower()
        if low == pack.slug or low == pack.name.lower() or low in pack.name.lower():
            return {
                "ok": True, "tailoring": "curated", "slug": pack.slug,
                **pack.to_dict(), "disclaimer": companies.DISCLAIMER,
            }

    role_line = f"Role the candidate is applying for: {role_hint}\n" if role_hint else ""
    prompt = _PROMPT.format(name=typed, role_line=role_line)

    # WHOLE responses, judged one at a time. NOT chat_json_ensemble.
    #
    # That helper merges the N answers, and `llm._merge_lists` keeps only the
    # list items a majority of providers produced VERBATIM. Two models asked how
    # Tesla screens resumes both answer well and neither writes the same
    # sentence as the other, so the merged `emphasis` and `keywords` come back
    # empty every time. `_verdict` then sees no emphasis and no vocabulary and
    # declines — correctly, given what it was handed.
    #
    # Measured on production: provider A returned known=true, confidence 0.8, 4
    # emphasis lines and 10 keywords; provider B returned known=true, confidence
    # 1.0, 3 lines and 10 keywords; the merge returned 0 and 0. So every company
    # without a curated pack answered "we know nothing specific about them",
    # including Tesla, Netflix and Apple. The feature had never worked outside
    # its tests, which stubbed the merge helper and so never exercised the merge.
    #
    # This is the same trap documented at length in `resume_optimize._rewrite_
    # struct`, and the same fix: take un-merged responses and keep the best one.
    # Consensus is the wrong tool for a question whose answer is prose.
    try:
        raws = llm_mod.chat_ensemble(prompt, system=_SYSTEM, n=2, timeout=90,
                                     temperature=0.1)
    except Exception as e:  # noqa: BLE001
        print(f"[research] {typed}: lookup failed ({e})")
        raws = []

    best: dict | None = None
    declined: dict | None = None
    for raw in raws:
        parsed = llm_mod._extract_json(raw) if raw else None
        if not _validator(parsed):
            continue
        verdict = _verdict(parsed, typed)
        if verdict["tailoring"] != "generated":
            # Kept so a decline still answers about the company the model
            # recognised rather than about the string that was typed.
            declined = declined or verdict
            continue
        # Richest surviving answer wins — most emphasis lines and vocabulary
        # AFTER the filters, so a model that pads with generic resume advice
        # does not out-score one that answered the question.
        if best is None or (
            len(verdict["emphasis"]) + len(verdict["keywords"])
            > len(best["emphasis"]) + len(best["keywords"])
        ):
            best = verdict

    if best:
        return {"ok": True, **best, "disclaimer": companies.DISCLAIMER}

    # Nothing survived: no model configured, every provider failed, or every
    # answer was a guess. All three are the same answer to the user, and it is a
    # true one — so nothing here has to explain an outage to them.
    if declined:
        return {"ok": True, **declined, "disclaimer": companies.DISCLAIMER}
    return {
        "ok": True, "tailoring": "not_required", "name": typed,
        "note": NOT_REQUIRED_NOTE.format(name=typed),
        "emphasis": [], "keywords": [], "summary": "", "confidence": 0.0,
        "disclaimer": companies.DISCLAIMER,
    }
