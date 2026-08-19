"""A cover letter, under the same rules as everything else here.

WHY THIS IS THE HARDEST THING IN THIS CODEBASE TO DO HONESTLY

Every other output in Grindly is a rearrangement. A rewrite may reword, reorder,
merge and drop, and the three gates in resume_optimize.py check that nothing new
appeared. A cover letter is the opposite shape: it is prose ABOUT the candidate,
generated from scratch, and the entire genre is enthusiastic invention —
"I have always admired your commitment to...", "my three years leading a team
of engineers...". A model asked for a cover letter will produce claims the
candidate cannot defend, in the first paragraph, every time.

So the gates here are stricter than the resume's, not looser:

  1. TECHNOLOGY. Same vocabulary check as a rewrite. A tool named in the letter
     must appear on the resume.
  2. NUMBERS. Every figure in the letter must appear in the source. A model
     that writes "reduced latency by 40%" from a bullet saying "reduced
     latency" has invented a metric, and a metric is the most checkable and most
     damaging thing to get wrong.
  3. EMPLOYERS AND TITLES. Any capitalised proper noun must be either in the
     source or the target company's name.
  4. TENURE. Phrases of the form "N years" are rejected unless that exact span
     is in the source. This is the specific lie this format invites, and it is
     the one a recruiter checks first.

A letter that fails a gate is not repaired and re-offered. It is refused, with
the reason, because a cover letter is one paragraph of prose and a repaired one
is a different letter that nobody has read.

WHAT IT WILL NOT DO

It will not praise the company. Everything in that register is either unfalsifiable
filler or a claim about the reader's own employer that they will read as flattery.
The letter this produces says what the candidate has done and why it lines up with
what the role asks for, and stops.
"""
from __future__ import annotations

import re

import llm as llm_mod
import resume_optimize

_SYS = (
    "You write cover letters for a service that refuses to invent facts. You are "
    "given a candidate's resume as text, and optionally a company name and the "
    "requirements of a role. Write a short cover letter and return JSON:\n"
    '{"letter": "<the letter body, 3 short paragraphs, no salutation, no sign-off>", '
    '"used": [<the specific facts from the resume you relied on>]}\n'
    "ABSOLUTE RULES — a letter that breaks any of these is discarded entirely:\n"
    "1. Every fact must already be in the resume. No technology, employer, "
    "school, date, number, percentage, or duration that is not there.\n"
    "2. Never state how many years of experience the candidate has unless the "
    "resume says so in those words.\n"
    "3. Never praise or characterise the company. You know nothing about it "
    "beyond its name and what the role asks for.\n"
    "4. No adjectives about the candidate's character — 'passionate', "
    "'hardworking', 'detail-oriented'. Those are claims nobody can check and "
    "every letter contains them.\n"
    "5. Plain sentences. No 'I am writing to express my interest'.\n"
    "Write about what they did and how it lines up with the role. Nothing else."
)

# "three years", "3+ years", "over five years of experience"
_TENURE_RE = re.compile(
    r"\b(\d+\+?|one|two|three|four|five|six|seven|eight|nine|ten)\s*\+?\s*"
    r"(?:years?|yrs?)\b",
    re.I,
)

_WORD_NUMBERS = {
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
}

# Figures worth checking. Bare years (1990-2099) are excluded: a date already in
# the resume's employment history reads as a number the letter invented if the
# stem set happens to hold it differently, and a year is not a claim about
# achievement.
_NUMBER_RE = re.compile(r"\b\d+(?:\.\d+)?%?\b")

_MIN_CHARS = 200
_MAX_CHARS = 2200

# Vocabulary entries that are also ordinary English.
#
# The technology check works well on a resume struct, where a bullet is
# telegraphic and "data" almost always means the tool. It does not survive
# contact with prose: "I took one data path from forty minutes down to six"
# trips on `data` and `six`, and a gate that rejects an honest letter for using
# the word "data" has not made the product safer, it has removed the feature.
#
# Every word here is a real vocabulary entry that a person writing English
# cannot avoid. The trade is explicit: a letter claiming Go or R specifically
# gets through unchecked by THIS rule, and is still caught by the proper-noun
# rule when capitalised and by nothing when not. That is a narrow miss against
# a gate that would otherwise fire on almost every honest draft.
_AMBIGUOUS_IN_PROSE = frozenset({
    "c", "r", "go", "six", "data", "deep", "face", "user", "rest", "boot",
    "sem", "node", "dart", "solr", "api",
})


def _numbers_in(text: str) -> list[str]:
    out = []
    for raw in _NUMBER_RE.findall(text or ""):
        bare = raw.rstrip("%")
        try:
            value = float(bare)
        except ValueError:
            continue
        # A four-digit year is not an achievement metric.
        if raw.isdigit() and 1900 <= value <= 2099:
            continue
        out.append(bare)
    return out


def _proper_nouns(text: str) -> list[str]:
    """Capitalised words that are not sentence-initial.

    Deliberately crude, and deliberately biased towards catching too much: the
    cost of a false positive is one refused letter, and the cost of a false
    negative is a fabricated employer in a document sent under someone's name.
    """
    out = []
    for sentence in re.split(r"(?<=[.!?])\s+", text or ""):
        words = sentence.split()
        for word in words[1:]:
            token = word.strip(".,;:()'\"")
            if len(token) > 1 and token[0].isupper() and not token.isupper():
                out.append(token)
    return out


def check(letter: str, source_text: str, company: str = "") -> list[str]:
    """Every reason this letter cannot be handed over. Empty means it passed.

    Exported so the tests can hand it a deliberately fabricated letter and see
    the gate hold, which is the only way to prove a gate works — a real model
    mostly behaves.
    """
    problems: list[str] = []
    stems = resume_optimize._source_stems(source_text)
    allowed = resume_optimize._allowed_tokens(source_text, [])
    lower_source = (source_text or "").lower()
    company_tokens = {t.lower() for t in re.findall(r"[A-Za-z0-9]+", company or "")}

    # 1. Technology
    #
    # `flagged` is keyed on the offending TOKEN rather than on the message, so a
    # word caught by both this rule and the proper-noun rule below — which is
    # what "Kubernetes" is — is reported once. One invented word is one fault,
    # and a list that says the same thing twice reads as two problems.
    flagged: set[str] = set()
    vocab = resume_optimize._tech_vocab()
    for token in re.findall(r"[a-z0-9+#.]+", (letter or "").lower()):
        token = token.strip(".")
        if not token or token in allowed or token in _AMBIGUOUS_IN_PROSE:
            continue
        if token in vocab:
            flagged.add(token)
            problems.append(f"names a technology that is not on the resume: {token}")

    # 2. Numbers
    for number in _numbers_in(letter):
        if number not in stems and number not in lower_source:
            problems.append(f"states a figure that is not on the resume: {number}")

    # 3. Proper nouns
    for noun in _proper_nouns(letter):
        low = noun.lower()
        if low in company_tokens or low in stems or low in lower_source:
            continue
        # Ordinary English that happens to be capitalised mid-sentence.
        if low in {"i", "my", "the", "a", "an", "and", "monday", "friday"}:
            continue
        if low in flagged:
            continue  # already reported as an invented technology
        flagged.add(low)
        problems.append(f"names something that is not on the resume: {noun}")

    # 4. Tenure
    for match in _TENURE_RE.finditer(letter or ""):
        span = match.group(0)
        count = match.group(1).lower().rstrip("+")
        digits = _WORD_NUMBERS.get(count, count)
        # The claim is allowed only if the source says it in a form that would
        # read the same way to a recruiter.
        if not re.search(rf"\b{re.escape(digits)}\s*\+?\s*(?:years?|yrs?)\b", lower_source):
            problems.append(f"claims a length of experience the resume does not state: {span.strip()}")

    # De-duplicated, because one invented word repeated four times is one fault.
    seen: set[str] = set()
    unique = []
    for problem in problems:
        if problem in seen:
            continue
        seen.add(problem)
        unique.append(problem)
    return unique


def write(
    source_text: str,
    company: str = "",
    role: str = "",
    requirements: list[str] | None = None,
) -> dict:
    """Produce a letter, or say why there is not one.

    Returns {"ok": True, "letter": str, "used": [...]} or
    {"ok": False, "error": str, "problems": [...]}.
    """
    text = (source_text or "").strip()
    if len(text) < 400:
        return {
            "ok": False,
            "error": "There is not enough on this resume to write a letter from.",
            "problems": [],
        }

    wants = ", ".join((requirements or [])[:12])
    prompt = (
        f'Resume:\n"""\n{text[:6000]}\n"""\n\n'
        + (f"Company: {company}\n" if company else "")
        + (f"Role: {role}\n" if role else "")
        + (f"The role asks for: {wants}\n" if wants else "")
        + "\nReturn the JSON object described in your instructions."
    )

    # Several attempts, and each is checked independently rather than merged.
    # Merging prose by consensus produces a sentence no model wrote — see the
    # extraction bug documented in resume_optimize._extract_struct, where a
    # majority-vote merge over list items returned nothing at all.
    raws = llm_mod.chat_ensemble(prompt, system=_SYS, n=3, timeout=90)

    last_problems: list[str] = []
    for raw in raws:
        parsed = llm_mod._extract_json(raw) if raw else None
        if not isinstance(parsed, dict):
            continue
        letter = str(parsed.get("letter") or "").strip()
        if not (_MIN_CHARS <= len(letter) <= _MAX_CHARS):
            continue

        problems = check(letter, text, company)
        if problems:
            last_problems = problems
            print(f"[cover] rejected a draft: {problems[:3]}")
            continue

        used = [str(u).strip() for u in (parsed.get("used") or []) if str(u).strip()][:8]
        return {"ok": True, "letter": letter, "used": used}

    if last_problems:
        return {
            "ok": False,
            "error": (
                "Every draft made a claim your resume does not support, so none of them "
                "are worth sending. This usually means the role is asking for something "
                "you have not written down yet."
            ),
            "problems": last_problems[:5],
        }
    return {
        "ok": False,
        "error": "No letter could be produced — the model was unreachable.",
        "problems": [],
    }
