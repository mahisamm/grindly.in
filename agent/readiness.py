"""The Grindly Readiness Score — a measurement, not an opinion.

Every competitor in this category sells an "ATS score". No such number exists.
Workday, Greenhouse, iCIMS, Lever and Taleo parse a document into database
fields and let a recruiter filter the result; they do not grade resumes and they
do not auto-reject on a score. So a product that promises "82/100 ATS" is
promising a number that no system anywhere computes, which is both a marketing
claim nobody can substantiate and — far worse for us — a number we cannot debug.

This module computes something different and defensible: what a machine can
actually recover from the document, scored by rules that always return the same
answer for the same bytes. No model is consulted. `score()` is a pure function of
its inputs, which is what lets `resume_optimize` compare a rewrite against the
master honestly. The previous headline number came from `resume_ai.analyze()` —
an LLM ensemble whose own comments record the same resume landing on 70, 76 and
88 on three consecutive runs. A ruler that moves ±9 cannot measure a 6-point
improvement, and every "we made your resume better" claim built on it was
unfalsifiable.

The five bands, and why each one is here rather than a style opinion:

  readable   (30)  Text survives extraction at all. An image-only export looks
                   perfect to a human and is empty to a parser; this is the one
                   failure that silently sinks 100% of applications.
  fields     (20)  Name, email, phone, links and dates land where a parser looks
                   for them. A truncated email is an application nobody can reply
                   to.
  structure  (15)  Standard headings, real bullets, one column. Named sections
                   are how a parser knows which block is employment history.
  impact     (20)  Bullets that lead with an action and state an outcome. This is
                   the only band about the human reader, and it is measured
                   mechanically (verb position, quantity presence), never judged.
  coverage   (15)  Skills the target role asks for that the page actually shows.
                   Only scored when a job description is supplied; otherwise its
                   weight is redistributed across the other four, so a resume
                   with no target is never punished for having no target.

A band's findings are ordered hardest-problem-first and each carries a `fix`
written to be read by the candidate, not by us.
"""
from __future__ import annotations

import re
import unicodedata

# ---------------------------------------------------------------------------
# thresholds — all measured, all documented
# ---------------------------------------------------------------------------

# Below this, no meaningful text came out of the file. A recruiter's ATS runs the
# same class of extractor we do, so if pdfminer sees nothing the ATS sees nothing.
MIN_READABLE_CHARS = 220

# A one-page fresher resume is ~1800-3500 characters of extracted text. Under
# 900 the document is real but thin; over 9000 it is almost certainly 3+ pages.
THIN_CHARS = 900
BLOATED_CHARS = 9000

# PDF text layers leave these behind when a resume uses an icon font with no
# Unicode mapping (FontAwesome is the usual culprit). They render as mojibake in
# any rebuild and they are a reliable tell that the source was over-designed.
_CID_RE = re.compile(r"\(cid:\d+\)")

# Ligature and private-use codepoints that some LaTeX/Word exports emit instead
# of real letters. A parser that splits on word boundaries mangles them.
_PUA_RE = re.compile("[\ue000-\uf8ff]")

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
# Deliberately permissive on separators, strict on digit count (validated after
# the match) so "2020-2024" and a 6-digit pincode never read as a phone number.
_PHONE_RE = re.compile(r"(?<![\w@.])(\+?\d[\d\s().\-]{7,}\d)(?![\w])")
_URL_RE = re.compile(r"\b(?:https?://|www\.)[^\s|,;]+|\b(?:linkedin\.com|github\.com|gitlab\.com)/[^\s|,;]+", re.I)

# A date range a parser can read: "Jan 2023 - Present", "2021-2024", "03/2022".
_MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)"
_DATE_RANGE_RE = re.compile(
    rf"(?:{_MONTHS}[a-z]*\.?\s*\d{{4}}|\d{{1,2}}[/-]\d{{4}}|\b(?:19|20)\d{{2}}\b)"
    rf"\s*(?:-|–|—|to|until|through)\s*"
    rf"(?:{_MONTHS}[a-z]*\.?\s*\d{{4}}|\d{{1,2}}[/-]\d{{4}}|\b(?:19|20)\d{{2}}\b|present|current|now|ongoing)",
    re.I,
)

# Section headings a parser recognises. Each tuple is (canonical, alternatives)
# — we score on the canonical concept being findable, not on exact wording, but
# a resume that calls Experience "My Journey" is genuinely harder to parse and
# the finding says so.
SECTION_PATTERNS: dict[str, str] = {
    "experience": r"\b(?:work\s+)?experience\b|\bemployment\b|\bprofessional\s+background\b|\binternships?\b",
    "education": r"\beducation\b|\bacademics?\b|\bqualifications?\b",
    "skills": r"\b(?:technical\s+)?skills\b|\btechnolog(?:y|ies)\b|\btech\s+stack\b|\bcompetenc",
    "projects": r"\bprojects?\b|\bportfolio\b|\bpersonal\s+work\b",
}
# Which of the above a resume must have to be considered structurally complete.
# Projects is not required — a mid-career resume legitimately has none — but
# either experience or projects must exist, checked separately.
REQUIRED_SECTIONS = ("education", "skills")

# Bullet glyphs real resumes use, plus the hyphen and asterisk that plain-text
# exports degrade to.
_BULLET_RE = re.compile(r"^\s*(?:[•▪●◦‣⁃∙▪●○–—*+·]|-\s)\s*")

# Leading a bullet with a past-tense action verb is the one piece of resume
# style with genuine parser-independent value: it puts the verb where both a
# human scanner and a keyword search find it. This list is checked as a stem, so
# "engineered"/"engineering" both hit "engineer".
ACTION_STEMS = frozenset("""
build built creat develop design implement architect engineer deploy ship launch
led lead manag direct coordinat organis organiz drove drive spearhead found
improv optimis optimiz reduc increas boost accelerat scal grew grow rais
automat migrat refactor integrat configur maintain debug fix resolv
analys analyz research investigat model forecast measur benchmark
wrote writ author document present taught teach mentor train
won win rank achiev deliver complet secur earn
test validat verif audit review
""".split())

# Words that inflate a bullet without adding a fact. Counted, not banned — a
# couple is normal writing, a dozen is padding.
FILLER_WORDS = frozenset("""
responsible various numerous several successfully effectively efficiently
passionate hardworking dynamic proactive synergy leverage utilise utilize
detail-oriented team-player self-motivated go-getter results-driven
""".split())

# A quantity: a number with a unit, a percentage, a currency amount, a count.
#
# The unit may sit up to two words after the number, because that is how people
# actually write: "12000 daily requests", "40 unit tests", "300 active users".
# Requiring the unit to be adjacent missed every one of those — the first test
# case written against this pattern, "12000 daily requests", came straight off a
# real resume and did not match.
_UNIT = (
    r"%|percent|x|k|m|bn|cr|lakhs?|crores?"
    r"|ms|sec|secs|seconds?|mins?|minutes?|hrs?|hours?|days?|weeks?|months?|years?"
    r"|users?|customers?|clients?|students?|records?|rows?|requests?|queries?"
    r"|tests?|cases?|commits?|prs?|downloads?|installs?|members?|people|teams?"
    r"|projects?|articles?|papers?|frames?|images?|files?|events?|orders?"
    r"|fps|gb|mb|kb|tb|qps|rps"
)
_QUANTITY_RE = re.compile(
    r"(?<![\w.])"
    # currency amount, with an optional Indian/Western magnitude suffix
    r"(?:[₹$€£]\s?\d[\d,.]*\s?(?:k|m|bn|cr|lakhs?|crores?)?"
    # a bare number followed, within two words, by a unit
    r"|\d[\d,.]*\s?(?:[a-z][a-z-]*\s+){0,2}(?:" + _UNIT + r")(?![a-z])"
    # "1000+", "200+" — a floor stated without a unit. THREE digits minimum,
    # because the shorter forms are almost always version numbers: "Java 8+",
    # "React 18+" and "Python 3+" were all counted as achievement metrics and
    # inflated the impact band for resumes that stated no outcomes at all.
    # "50k+" still matches, via the magnitude-suffix branch above.
    r"|\d[\d,.]{2,}\+"
    # a percentage written with the symbol attached
    r"|\d[\d,.]*%)",
    re.I,
)

# Band weights. `coverage` is conditional — see `_weights()`.
BAND_WEIGHTS = {
    "readable": 30,
    "fields": 20,
    "structure": 15,
    "impact": 20,
    "coverage": 15,
}

GRADE_BANDS = ((85, "A"), (70, "B"), (55, "C"), (40, "D"))


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

def _norm(text: str) -> str:
    """Normalise for matching without destroying the layout signals we measure."""
    return unicodedata.normalize("NFKC", text or "")


def _lines(text: str) -> list[str]:
    return [ln.rstrip() for ln in _norm(text).splitlines()]


def _glyph_bullets(text: str) -> list[str]:
    """Lines that carry a real bullet glyph, with the glyph stripped."""
    out: list[str] = []
    for ln in _lines(text):
        if _BULLET_RE.match(ln):
            stripped = _BULLET_RE.sub("", ln).strip()
            if stripped:
                out.append(stripped)
    return out


def _bullet_lines(text: str, allow_fallback: bool = True) -> list[str]:
    """Bullets, optionally inferring them when the text layer dropped the glyphs.

    Two callers with genuinely different needs, which is why this takes a flag
    rather than guessing once:

    `structure` passes allow_fallback=False. Whether the document HAS bullets is
    the thing that band measures, so inferring them would be answering its own
    question — and it did: a wall of prose scored 82 on structure because every
    wrapped sentence was counted as a bullet point.

    `impact` passes allow_fallback=True, because a resume whose PDF export
    stripped the glyphs still has real bullets and deserves to be judged on how
    they are written. The fallback is gated on the document having at least two
    recognisable section headings, so a personal statement with no structure at
    all cannot be read as a bullet list — it has nothing for the inference to
    anchor to, and inferring anyway is how prose scored 0 on impact for the
    right reason and 82 on structure for the wrong one.
    """
    out = _glyph_bullets(text)
    if out or not allow_fallback:
        return out

    sections = find_sections(text)
    if sum(1 for present in sections.values() if present) < 2:
        return []

    for ln in _lines(text):
        s = ln.strip()
        if 40 <= len(s) <= 300 and not s.endswith(":") and " " in s:
            out.append(s)
    return out


def _first_word_stem(sentence: str) -> str:
    m = re.match(r"[^\w]*([A-Za-z]+)", sentence or "")
    if not m:
        return ""
    return m.group(1).lower()


def _is_action_led(sentence: str) -> bool:
    w = _first_word_stem(sentence)
    if not w:
        return False
    return any(w.startswith(stem) for stem in ACTION_STEMS)


def _digits(s: str) -> int:
    return sum(ch.isdigit() for ch in s)


def find_emails(text: str) -> list[str]:
    return _EMAIL_RE.findall(_norm(text))


# A run of years — "Batch 2020 2024 2021", a list of graduation years — has a
# phone-number digit count and no other tell. Rejected explicitly, because
# awarding the phone credit to a resume with no phone number on it is exactly
# the kind of quiet wrongness that makes the whole score untrustworthy.
_YEAR_RUN_RE = re.compile(r"^(?:(?:19|20)\d{2}[\s,-]*){2,}$")


def find_phones(text: str) -> list[str]:
    out = []
    for m in _PHONE_RE.finditer(_norm(text)):
        span = m.group(1).strip()
        if not (10 <= _digits(span) <= 13):
            continue
        if _YEAR_RUN_RE.match(span):
            continue
        out.append(span)
    return out


def find_links(text: str) -> list[str]:
    return [u.rstrip(".,);") for u in _URL_RE.findall(_norm(text))]


def find_sections(text: str) -> dict[str, bool]:
    low = _norm(text).lower()
    return {name: bool(re.search(pat, low)) for name, pat in SECTION_PATTERNS.items()}


def find_date_ranges(text: str) -> list[str]:
    return [m.group(0) for m in _DATE_RANGE_RE.finditer(_norm(text))]


# ---------------------------------------------------------------------------
# bands
# ---------------------------------------------------------------------------

def _finding(severity: str, band: str, problem: str, fix: str) -> dict:
    return {"severity": severity, "band": band, "problem": problem, "fix": fix}


# A two-column layout collapses to ONE wide gap per line, not two — the original
# check here required two gaps and so never fired on the exact layout it was
# written for. But a single wide gap is also what a perfectly good single-column
# resume produces when it right-aligns dates ("Acme Corp        Jun 2024"), and
# flagging those as broken would be worse than missing the real thing.
#
# What separates them is consistency and payload. In a true two-column document
# the split sits at nearly the same character position on line after line, and
# the right-hand side carries real content. Right-aligned dates wander with the
# length of the employer's name and the right side is a short date.
_GAP_RE = re.compile(r"\S( {6,})\S")
# Deliberately LOW. The exclusion that matters is semantic
# (`_looks_like_aligned_meta`), not length: raising this to 25 to keep date
# ranges out also excluded "Intern, Acme Corp" and "B.Com, Delhi University" —
# real second-column content — and the detector then missed genuine two-column
# layouts entirely. Length only screens out fragments.
_MIN_RIGHT_CHARS = 12
_MIN_COLUMN_LINES = 5       # below this there is not enough evidence either way
_MIN_COLUMN_SHARE = 0.22    # of non-empty lines
_MAX_GAP_SPREAD = 8.0       # std-dev, in characters, of where the split falls

# The right-hand side of a right-aligned line on an ordinary single-column
# resume: a date range, a location, a GPA. Excluded by MEANING rather than by
# length, because the length rule alone was wrong in the most common case.
#
# `_MIN_RIGHT_CHARS` was 15, with the comment "a date is shorter than this". A
# date RANGE is not: "Jun 2025 - Aug 2025" is 19 characters. So every ordinary
# resume that right-aligns its employment dates — which is most of them — was
# detected as two-column and shown a critical "your layout is broken" finding
# plus a 15% structure penalty, for having a completely standard layout.
_ALIGNED_META_RE = re.compile(
    rf"^(?:{_MONTHS}[a-z]*\.?\s*)?\(?\d{{1,4}}"          # starts with a date-ish token
    r"|^\(?\d{1,2}[/-]\d{2,4}"
    r"|^(?:present|current|ongoing|remote|onsite|hybrid)\b",
    re.I,
)


def _looks_like_aligned_meta(right: str) -> bool:
    """True when the right-hand side is a date/period rather than a column."""
    text = right.strip()
    if _DATE_RANGE_RE.search(text):
        return True
    if _ALIGNED_META_RE.search(text):
        return True
    # Mostly digits and month names, with very few real words.
    words = re.findall(r"[A-Za-z]{3,}", text)
    return len(text) <= 30 and len(words) <= 2


def detect_two_column(lines: list[str]) -> dict:
    """Heuristic two-column detection over extracted text lines.

    Returns {"is_two_column": bool, "lines": int, "share": float, "spread": float}
    so the caller can show its working rather than asserting a verdict.

    Tuned to avoid FALSE POSITIVES specifically. Telling someone with a perfectly
    normal resume that their layout is broken destroys trust in every other
    number on the page; missing a genuine two-column layout costs them one
    finding they can still see for themselves on the "what the machine reads"
    tab.
    """
    positions: list[int] = []
    for ln in lines:
        m = _GAP_RE.search(ln)
        if not m:
            continue
        right = ln[m.end(1):].strip()
        if len(right) < _MIN_RIGHT_CHARS or _looks_like_aligned_meta(right):
            continue
        positions.append(m.start(1))

    non_empty = max(1, len(lines))
    share = len(positions) / non_empty
    spread = _stdev(positions)
    is_two = (
        len(positions) >= _MIN_COLUMN_LINES
        and share >= _MIN_COLUMN_SHARE
        and spread <= _MAX_GAP_SPREAD
    )
    return {
        "is_two_column": is_two,
        "lines": len(positions),
        "share": round(share, 3),
        "spread": round(spread, 2),
    }


def _stdev(values: list[int]) -> float:
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return (sum((v - mean) ** 2 for v in values) / len(values)) ** 0.5


def _band_readable(text: str) -> tuple[float, list[dict], dict]:
    """Did anything survive extraction, and is what survived clean?"""
    raw = _norm(text)
    # Runs of whitespace collapsed BEFORE counting. Measuring `len(raw.strip())`
    # counted layout padding as content: a resume with right-aligned dates gets
    # hundreds of free "characters of text" it does not have, so heavy alignment
    # bought score and a dense resume was told it was "very short". The band
    # claims to measure text; it now measures text.
    chars = len(re.sub(r"\s+", " ", raw).strip())
    findings: list[dict] = []
    facts = {"chars": chars, "cid_artifacts": len(_CID_RE.findall(raw)),
             "pua_artifacts": len(_PUA_RE.findall(raw))}

    if chars < MIN_READABLE_CHARS:
        findings.append(_finding(
            "critical", "readable",
            f"Only {chars} characters could be read out of this file.",
            "The resume is almost certainly an image or a scan. Export it from "
            "Word or Google Docs as a PDF — never 'print to image', never a "
            "screenshot. A parser reads nothing off this and no recruiter ever "
            "sees it.",
        ))
        # Nothing else can be judged, so the band scores near-zero and the
        # caller still gets a complete report rather than an exception.
        return (0.05 if chars else 0.0), findings, facts

    ratio = 1.0
    if chars < THIN_CHARS:
        ratio -= 0.25
        findings.append(_finding(
            "warning", "readable",
            f"Only {chars} characters of text — this reads as a very short resume.",
            "Give each project and role its own bullets naming the tools, the "
            "task and the outcome. A page a recruiter can scan beats half a page "
            "they finish in four seconds.",
        ))
    elif chars > BLOATED_CHARS:
        ratio -= 0.15
        findings.append(_finding(
            "warning", "readable",
            f"{chars} characters — that is three pages or more of text.",
            "Indian campus recruiters expect one page. Cut the oldest roles and "
            "any bullet that does not name a tool or an outcome.",
        ))

    if facts["cid_artifacts"]:
        ratio -= 0.30
        findings.append(_finding(
            "critical", "readable",
            f"{facts['cid_artifacts']} unreadable glyphs in the text layer "
            f"(icon fonts with no Unicode mapping).",
            "The icons beside your phone and email extract as garbage. Replace "
            "them with plain words — 'Email:', 'Phone:', 'GitHub:'.",
        ))
    if facts["pua_artifacts"]:
        ratio -= 0.15
        findings.append(_finding(
            "warning", "readable",
            f"{facts['pua_artifacts']} private-use characters in the text.",
            "Some letters are stored as font-specific symbols rather than real "
            "text. Re-export the PDF with font embedding, or rebuild it here.",
        ))

    return max(0.0, min(1.0, ratio)), findings, facts


def _band_fields(text: str) -> tuple[float, list[dict], dict]:
    """Can a parser fill in its database columns?"""
    emails = find_emails(text)
    phones = find_phones(text)
    links = find_links(text)
    dates = find_date_ranges(text)
    facts = {"emails": emails[:3], "phones": phones[:3],
             "links": links[:6], "date_ranges": len(dates)}
    findings: list[dict] = []

    # Four sub-checks, weighted by how badly the application fails without them.
    got = 0.0
    if emails:
        got += 0.40
    else:
        findings.append(_finding(
            "critical", "fields",
            "No email address could be read off the resume.",
            "Put a plain-text email in the header. If it is behind an icon or "
            "inside an image, no employer can reply to you.",
        ))

    if phones:
        got += 0.25
    else:
        findings.append(_finding(
            "warning", "fields",
            "No phone number could be read off the resume.",
            "Add a phone number in the header as plain digits. Indian recruiters "
            "call before they email.",
        ))

    if links:
        got += 0.15
    else:
        findings.append(_finding(
            "warning", "fields",
            "No LinkedIn or GitHub link is visible in the text.",
            "Write the URL out ('github.com/yourname'), not just the word "
            "'GitHub' behind a hyperlink — extractors read text, not link "
            "annotations.",
        ))

    if len(dates) >= 2:
        got += 0.20
    elif len(dates) == 1:
        got += 0.10
        findings.append(_finding(
            "warning", "fields",
            "Only one date range is readable.",
            "Give every role and project a start and end date in a standard "
            "form — 'Jan 2024 – Jun 2024'. Filters sort candidates by these.",
        ))
    else:
        findings.append(_finding(
            "critical", "fields",
            "No date ranges a parser can read.",
            "Add dates in a standard form — 'Jan 2024 – Present'. Without them a "
            "recruiter cannot tell how recent your experience is, and date "
            "filters skip you entirely.",
        ))

    return got, findings, facts


def _band_structure(text: str) -> tuple[float, list[dict], dict]:
    """Standard headings and real bullets, in one column."""
    sections = find_sections(text)
    # Real glyphs only — see _bullet_lines. Whether this document has bullets is
    # exactly what is being measured here.
    bullets = _bullet_lines(text, allow_fallback=False)
    lines = [ln for ln in _lines(text) if ln.strip()]
    facts = {"sections": sections, "bullets": len(bullets), "lines": len(lines)}
    findings: list[dict] = []
    got = 0.0

    missing = [name for name in REQUIRED_SECTIONS if not sections.get(name)]
    if not missing:
        got += 0.35
    else:
        got += 0.35 * (1 - len(missing) / len(REQUIRED_SECTIONS))
        findings.append(_finding(
            "critical" if len(missing) > 1 else "warning", "structure",
            f"No section a parser recognises as: {', '.join(missing)}.",
            "Use plain headings — 'Education', 'Technical Skills'. A creative "
            "heading is how a parser loses a whole block of your resume.",
        ))

    if sections.get("experience") or sections.get("projects"):
        got += 0.25
    else:
        findings.append(_finding(
            "critical", "structure",
            "Neither an Experience nor a Projects section could be found.",
            "Add one, headed exactly 'Experience' or 'Projects'. This is the "
            "block recruiters search; without it there is nothing to match.",
        ))

    if len(bullets) >= 6:
        got += 0.25
    elif bullets:
        got += 0.25 * (len(bullets) / 6)
        findings.append(_finding(
            "warning", "structure",
            f"Only {len(bullets)} bullet points across the whole resume.",
            "Break each role and project into two or three bullets. A paragraph "
            "is skipped; a bullet is read.",
        ))
    else:
        findings.append(_finding(
            "critical", "structure",
            "No bullet points found — the resume reads as prose.",
            "Rewrite each role and project as short bullets. Nobody reads "
            "resume paragraphs, and a keyword buried in one is easy to miss.",
        ))

    col = detect_two_column(lines)
    facts["two_column"] = col
    if len(lines) < _MIN_COLUMN_LINES:
        # Not enough document to have a layout. Awarding the not-two-column
        # credit here gave an EMPTY file 15/100 on structure, printed beside a
        # critical finding saying nothing could be read out of it.
        pass
    elif col["is_two_column"]:
        findings.append(_finding(
            "critical", "structure",
            f"The layout looks like two columns — {col['lines']} lines split at "
            f"roughly the same position, so the extracted text interleaves.",
            "Rebuild as a single column. Columns are the single most common "
            "reason a well-designed resume parses as nonsense: the machine reads "
            "your job title into the middle of your skills list.",
        ))
    else:
        got += 0.15

    return min(1.0, got), findings, facts


def _band_impact(text: str) -> tuple[float, list[dict], dict]:
    """Do bullets lead with an action and state an outcome?"""
    bullets = _bullet_lines(text)
    findings: list[dict] = []

    if not bullets:
        return 0.0, [_finding(
            "critical", "impact",
            "No bullets to judge, so no evidence of impact is visible.",
            "Write each achievement as a bullet that starts with a verb and "
            "ends with a result.",
        )], {"bullets": 0, "action_led": 0, "quantified": 0, "filler": 0}

    action_led = sum(1 for b in bullets if _is_action_led(b))
    quantified = sum(1 for b in bullets if _QUANTITY_RE.search(b))
    filler = sum(
        1 for b in bullets
        for w in re.findall(r"[a-z-]+", b.lower())
        if w in FILLER_WORDS
    )
    over_long = sum(1 for b in bullets if len(b) > 240)

    facts = {
        "bullets": len(bullets),
        "action_led": action_led,
        "quantified": quantified,
        "filler": filler,
        "over_long": over_long,
        "action_pct": round(100 * action_led / len(bullets)),
        "quantified_pct": round(100 * quantified / len(bullets)),
    }

    action_ratio = action_led / len(bullets)
    quant_ratio = quantified / len(bullets)

    # Full marks at 90% action-led and 55% quantified.
    #
    # These were 80% and 40%, with a comment claiming 40% was "what an honest
    # strong resume actually reaches". The first genuinely strong resume run
    # through this scorer reached 82% and 73% and took the band to a flat 100,
    # which made the whole score top out — a ruler with no headroom cannot show
    # a rewrite improving anything, and this product's entire job is to show
    # exactly that. The old numbers were a guess; these are set above a measured
    # strong resume so that full marks means unusually good rather than good.
    #
    # 55% is still deliberately short of "every bullet needs a number". Pushing
    # toward 100% quantified is how competing tools talk people into inventing
    # metrics, and a number the candidate cannot defend in the interview costs
    # them more than a missing one ever will.
    got = 0.55 * min(1.0, action_ratio / 0.90) + 0.35 * min(1.0, quant_ratio / 0.55)

    # Filler is judged per bullet, not in absolute terms.
    filler_rate = filler / len(bullets)
    got += 0.10 * max(0.0, 1 - filler_rate / 0.5)

    if action_ratio < 0.6:
        findings.append(_finding(
            "warning", "impact",
            f"Only {facts['action_pct']}% of bullets start with an action verb.",
            "Start each bullet with what you did — 'Built', 'Reduced', "
            "'Automated' — not with 'Responsible for' or 'Worked on'.",
        ))
    if quant_ratio < 0.25:
        findings.append(_finding(
            "warning", "impact",
            f"Only {facts['quantified_pct']}% of bullets contain a number.",
            "Add the real figures you already know: how many users, how much "
            "faster, how many records. Never invent one — a number you cannot "
            "defend in the interview is worse than no number.",
        ))
    if filler_rate > 0.5:
        findings.append(_finding(
            "warning", "impact",
            f"{filler} filler words across {len(bullets)} bullets.",
            "Cut words like 'responsible for', 'various', 'successfully'. They "
            "take space a tool or a result could use.",
        ))
    if over_long:
        findings.append(_finding(
            "warning", "impact",
            f"{over_long} bullet(s) run past 240 characters.",
            "Split them. A bullet that wraps to three lines is read as a "
            "paragraph and skipped.",
        ))

    return min(1.0, got), findings, facts


def _band_coverage(text: str, jd_skills: list[str]) -> tuple[float, list[dict], dict]:
    """Which of the role's stated requirements the page actually shows."""
    wanted = [s for s in (jd_skills or []) if s and s.strip()]
    if not wanted:
        return 1.0, [], {"wanted": [], "covered": [], "missing": []}

    low = _norm(text).lower()
    covered, missing = [], []
    for skill in wanted:
        if _skill_present(low, skill):
            covered.append(skill)
        else:
            missing.append(skill)

    facts = {"wanted": wanted, "covered": covered, "missing": missing,
             "covered_pct": round(100 * len(covered) / len(wanted))}
    findings: list[dict] = []
    if missing:
        findings.append(_finding(
            "critical" if len(missing) > len(wanted) / 2 else "warning", "coverage",
            f"{len(missing)} of {len(wanted)} skills this role asks for are not "
            f"visible on your resume: {', '.join(missing[:6])}"
            + ("…" if len(missing) > 6 else ""),
            "If you have any of these, name them explicitly in a bullet or in "
            "Technical Skills — a recruiter searches for the exact word. If you "
            "do not have them, leave them off; Grindly will never add a skill "
            "you did not claim.",
        ))
    return len(covered) / len(wanted), findings, facts


# Vocabulary a recruiter's keyword search treats as the same thing. This is the
# "searches Kubernetes, resume says container orchestration" failure, and it runs
# in both directions.
SKILL_ALIASES: dict[str, tuple[str, ...]] = {
    "kubernetes": ("k8s", "container orchestration"),
    "javascript": ("js", "es6", "ecmascript"),
    "typescript": ("ts",),
    "postgresql": ("postgres", "psql"),
    "mongodb": ("mongo",),
    "amazon web services": ("aws",),
    "aws": ("amazon web services",),
    "google cloud": ("gcp", "google cloud platform"),
    "machine learning": ("ml",),
    "natural language processing": ("nlp",),
    "computer vision": ("cv", "opencv"),
    "continuous integration": ("ci", "ci/cd"),
    "react": ("react.js", "reactjs"),
    "node": ("node.js", "nodejs"),
    "next.js": ("nextjs", "next js"),
    "rest api": ("rest", "restful", "http api"),
    "c++": ("cpp",),
    "c#": ("csharp", "c sharp"),
    "objectoriented": ("oop", "object-oriented"),
    "structured query language": ("sql",),
}


def _skill_present(low_text: str, skill: str) -> bool:
    """Whole-token match for a skill or any of its aliases.

    Substring matching is wrong here in a way that quietly inflates every score:
    "R" matches every word containing the letter, and "go" matches "google". So
    each candidate is matched on token boundaries, with the boundary class
    widened to allow the punctuation real skill names carry (c++, c#, .net,
    node.js).
    """
    s = (skill or "").strip().lower()
    if not s:
        return False
    candidates = [s, *SKILL_ALIASES.get(s, ())]
    # Reverse aliases: the JD says "k8s", the resume says "kubernetes".
    for canonical, aliases in SKILL_ALIASES.items():
        if s in aliases and canonical not in candidates:
            candidates.append(canonical)
    for cand in candidates:
        pattern = r"(?<![a-z0-9])" + re.escape(cand) + r"(?![a-z0-9])"
        if re.search(pattern, low_text):
            return True
    return False


# ---------------------------------------------------------------------------
# public API
# ---------------------------------------------------------------------------

def _weights(has_jd: bool) -> dict[str, float]:
    """Band weights, with `coverage` redistributed when there is no target role.

    A resume with no job description attached is not a worse resume; it is a
    resume being measured on four dimensions instead of five. Scoring the
    missing band as zero (the obvious bug) would cap every untargeted resume at
    85 and make the headline number depend on whether the user had pasted a JD
    yet — which is exactly the kind of moving ruler this module exists to avoid.
    """
    w = dict(BAND_WEIGHTS)
    if has_jd:
        return {k: float(v) for k, v in w.items()}
    coverage = w.pop("coverage")
    total = sum(w.values())
    return {k: v + coverage * (v / total) for k, v in w.items()}


def grade(score: int) -> str:
    for cutoff, letter in GRADE_BANDS:
        if score >= cutoff:
            return letter
    return "F"


def score(resume_text: str, jd_skills: list[str] | None = None) -> dict:
    """The readiness report for one resume.

    Pure: same text and same skills always produce the same dict. No network, no
    model, no clock, no filesystem.

    Returns::

        {
          "score": int 0-100,
          "grade": "A".."F",
          "bands": {name: {"score": int 0-100, "weight": float, "points": float}},
          "findings": [{severity, band, problem, fix}, ...],   # worst first
          "facts": {band: {...}},                              # what was measured
          "targeted": bool,
        }
    """
    jd_skills = [s for s in (jd_skills or []) if s and s.strip()]
    has_jd = bool(jd_skills)

    ratios: dict[str, float] = {}
    findings: list[dict] = []
    facts: dict[str, dict] = {}

    for name, fn, args in (
        ("readable", _band_readable, (resume_text,)),
        ("fields", _band_fields, (resume_text,)),
        ("structure", _band_structure, (resume_text,)),
        ("impact", _band_impact, (resume_text,)),
    ):
        ratio, band_findings, band_facts = fn(*args)
        ratios[name] = ratio
        findings.extend(band_findings)
        facts[name] = band_facts

    if has_jd:
        ratio, band_findings, band_facts = _band_coverage(resume_text, jd_skills)
        ratios["coverage"] = ratio
        findings.extend(band_findings)
        facts["coverage"] = band_facts

    weights = _weights(has_jd)
    bands: dict[str, dict] = {}
    total = 0.0
    for name, weight in weights.items():
        ratio = ratios.get(name, 0.0)
        points = ratio * weight
        total += points
        bands[name] = {
            "score": int(round(ratio * 100)),
            "weight": round(weight, 1),
            "points": round(points, 1),
        }

    # An unreadable document cannot honestly score in the pass range on the
    # strength of the other bands — those bands are measuring the little text
    # that leaked out, not the resume. Cap it so the headline number never
    # contradicts the critical finding printed directly beneath it.
    final = int(round(total))
    if ratios.get("readable", 0.0) <= 0.05:
        final = min(final, 15)

    findings.sort(key=lambda f: (f["severity"] != "critical", f["band"]))
    return {
        "score": max(0, min(100, final)),
        "grade": grade(final),
        "bands": bands,
        "findings": findings,
        "facts": facts,
        "targeted": has_jd,
    }


def parse_fidelity(claimed_facts: list[str], extracted_text: str) -> dict:
    """How many of the candidate's own facts survive machine extraction.

    This is the number the product leads with, because it is the only claim in
    this category that is verifiable end to end: we rebuilt the document, read it
    back with the same class of extractor an ATS uses, and counted. `recovered /
    total` is a fact about two files, not a judgement about a career.
    """
    facts = [f for f in (claimed_facts or []) if f and f.strip()]
    if not facts:
        return {"total": 0, "recovered": 0, "lost": [], "pct": 100}

    low = _norm(extracted_text).lower()
    lost = []
    for fact in facts:
        if not _fact_present(low, fact):
            lost.append(fact)
    recovered = len(facts) - len(lost)
    return {
        "total": len(facts),
        "recovered": recovered,
        "lost": lost,
        "pct": round(100 * recovered / len(facts)),
    }


# A fact counts as recovered when most of its distinctive words survive. Exact
# string matching fails on line wrapping and on the whitespace a PDF text layer
# invents; requiring every word fails on a single hyphenation.
_FACT_MIN_RATIO = 0.7
_FACT_STOPWORDS = frozenset(
    "a an the and or of in on at to for with by from as is was were be been".split()
)


def _fact_present(low_text: str, fact: str) -> bool:
    """Did most of this fact's distinctive words survive, as WHOLE tokens?

    The membership test was `t in low_text` — a substring match, which is the
    exact bug `_skill_present` carries a docstring warning about. "Go" matched
    "google", "react" matched "reactor", and every fidelity percentage the
    product printed was inflated by fragments. Since fidelity is the headline
    claim ("a parser recovered 47 of your 51 facts"), an inflated one is the
    worst number in the product to get wrong.
    """
    tokens = [
        t for t in re.findall(r"[a-z0-9][a-z0-9+#.\-]*", fact.lower())
        if t not in _FACT_STOPWORDS and len(t) > 1
    ]
    if not tokens:
        return True
    hits = sum(
        1 for t in tokens
        if re.search(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])", low_text)
    )
    return hits / len(tokens) >= _FACT_MIN_RATIO
