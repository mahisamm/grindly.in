"""Resume reading — contact extraction, and prose advice that is never a score.

    extract_contact(text) -> dict  name, email, phone, GPA, school marks, links
    advise(text)          -> dict  strengths / issues / suggestions, as WORDS

`analyze()` used to live here and return a 0-100 "ATS score" from an LLM
ensemble. That number was the product's headline claim and it was not a
measurement: the same document scored 70, 76 and 88 on three consecutive runs,
because the providers that answer vary and the models disagree by ~15 points on
one unchanged resume. Every "we improved your resume by 8 points" built on it
was noise, and `resume_optimize` needed a ±6 fudge factor just to stop good
rewrites being discarded by the wobble.

The score now comes from `readiness.score()` — a pure function of the extracted
text, identical on every machine, every run. What is left in this module is the
half a model is genuinely good at: reading a name off a header, and writing a
sentence of advice. `advise()` deliberately returns NO score and NO grade, so
there is exactly one number in this product and exactly one place it comes from.

Everything LaTeX-related (tailor_latex, the .tex splice, the unsafe-command
denylist) is gone with the Tectonic dependency; see `render_pdf`. Everything
job-object-related (fit_score, _requirements) is gone with the job boards; the
coverage band in `readiness` replaced it and works off a pasted job description
instead of a scraped listing.
"""
from __future__ import annotations
import re

import llm as llm_mod

# ---------- prompts ----------

_ADVISE_SYS = (
    "You are a senior recruiter reviewing a candidate's resume. "
    "You do NOT score the resume and you never mention a score, a grade, a "
    "percentage, or an ATS rating — a separate deterministic checker owns those "
    "and your job is only the words. "
    "Return ONLY valid JSON with exactly these keys: "
    "strengths (array of 2-4 short strings — what genuinely works), "
    "issues (array of 2-5 short strings — what is missing or weak), "
    "suggestions (array of 3-5 actionable one-sentence improvements). "
    "Every suggestion must be something the candidate can act on using facts "
    "they already have. NEVER suggest adding a skill, employer, metric or "
    "achievement the resume does not already contain. "
    "Before writing each line, verify that every named technology, service, "
    "certification and number appears verbatim in the resume. Do not give "
    "examples of tools the candidate might have used; if the resume does not "
    "name one, discuss the missing specificity without naming a tool. "
    "No markdown, no prose outside the JSON object."
)

# ---------- public API ----------

def _advise_uncached(resume_text: str) -> dict:
    """Prose advice on a resume: strengths, issues, suggestions. Never a number.

    Always returns a dict with all three keys. When no provider answers, the
    heuristic fallback fills them — the advice is thinner but the shape is
    stable, so no caller has to branch on whether an LLM was reachable.
    """
    text = (resume_text or "").strip()
    if not text:
        return {**_fallback_advice(""), "source": "heuristic"}

    prompt = (
        f"Resume:\n\"\"\"\n{text[:24000]}\n\"\"\"\n\n"
        "Review this resume. Return valid JSON only."
    )
    # WHOLE responses, richest one wins. NOT chat_json_ensemble.
    #
    # That helper merges the N answers, and `llm._merge_lists` keeps only the
    # list items a majority of providers produced VERBATIM. Skill lists survive
    # that — three models asked for technologies all write "python" — but this
    # function asks for ADVICE, and three models never write the same sentence.
    #
    # Measured on production against a real resume: the providers returned 3, 3
    # and 4 strengths, 3, 4 and 4 issues, and 5 suggestions each. The merge
    # returned {"strengths": [], "issues": [], "suggestions": []}, so this
    # function fell through to `_fallback_advice` every single time. The panel
    # it feeds is titled "A recruiter's read" and tells the user it is a model's
    # opinion on their writing; they were reading a canned heuristic instead.
    #
    # temperature=0.0 because the same resume should get the same advice twice;
    # a reviewer whose opinion changes between refreshes is not a reviewer.
    try:
        raws = llm_mod.chat_ensemble(
            prompt, system=_ADVISE_SYS, n=3, timeout=60, temperature=0.0)
    except Exception as e:  # noqa: BLE001
        print(f"[advise] providers unavailable: {e}")
        raws = []

    best: dict | None = None
    best_weight = 0
    for raw in raws:
        parsed = llm_mod._extract_json(raw) if raw else None
        if not isinstance(parsed, dict):
            continue
        if not (parsed.get("suggestions") or parsed.get("issues")):
            continue
        try:
            advice = _ground_advice(_coerce_advice(parsed), text)
        except (ValueError, TypeError):
            continue
        weight = len(advice["strengths"]) + len(advice["issues"]) + len(advice["suggestions"])
        if weight > best_weight:
            best, best_weight = advice, weight

    # Say which it was. The shapes are identical, and a caller that cannot
    # tell "a model read this" from "every provider was rate-limited" charged
    # a quota unit for the rules, stored them as the review, and hid the
    # button — one canned review, permanently. The route refunds and says
    # "try again" on "heuristic"; the panel never shows rules as an opinion.
    if best:
        return {**best, "source": "model"}
    return {**_fallback_advice(text), "source": "heuristic"}


# ---------- ATS: what a machine actually reads off the page ----------

# Below this, no meaningful text came out of the file. A recruiter's ATS runs the
# same kind of extractor we do — so if pdfminer sees nothing, the ATS sees nothing,
# and the application is discarded before a human is ever involved.
_ATS_MIN_CHARS = 220

# The domain half must allow DOTS, or a multi-label TLD is silently truncated:
# `\.\w+` stops at the first dot after the host, so `priya@iitb.ac.in` was
# extracted as `priya@iitb.ac`. This is the regex that reads the candidate's own
# email off their resume and prefills it onto real application forms — a
# truncated address is one an employer cannot reply to, which costs the user the
# entire application. Indian academic addresses (.ac.in, .edu.in, .res.in) and
# .co.in are exactly the common case here.
_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")
_PHONE_RE = re.compile(r"(?:\+?\d[\d\s-]{7,}\d)")

# ---------- contact prefill: phone + GPA off the resume ----------
# Anchored to a label first ("Mobile: 98…", "CGPA: 8.4"), then a conservative loose
# fallback. Precision over recall: these values get typed into a real application
# form, so a wrong guess is worse than no guess — the user confirms them anyway.
# Digits may carry internal spaces/dashes ("98765 43210", "+91-98765-43210"); we
# capture loosely then strip and validate to a clean 10-digit Indian mobile.
_PHONE_ANCHORED = re.compile(
    r"(?:phone|mobile|contact|tel|call|whats\s?app|\bph\b|\bmob\b)[^\d+]{0,8}"
    r"((?:\+?\s?91[\s-]?)?[6-9](?:[\s-]?\d){9})", re.I)
_PHONE_LOOSE = re.compile(r"(?<!\d)((?:\+?91[\s-]?)?[6-9](?:[\s-]?\d){9})(?!\d)")
# GPA/CGPA off a resume. Two orders appear in the wild: label-then-value
# ("CGPA: 8.5") and value-then-label ("8.5/10 CGPA") — Indian student resumes use
# both freely. CGPA (cumulative) is the canonical figure, so it is matched before a
# bare GPA/SGPA when a resume lists more than one.
# The value is 0–10 only; the trailing (?!\d) stops "45.0" being read as "4" and
# stops a graduation year ("2025 CGPA batch") being read as a grade.
_GPA_VAL = r"(10(?:\.\d{1,2})?|[0-9](?:\.\d{1,2})?)"
# Reversed value carries a (?<![\d.]) so neither a graduation year's trailing digit
# ("2025 CGPA" → "5") nor a decimal fragment ("48.5 CGPA" → "5") is read as a grade.
_GPA_VAL_REV = r"(?<![\d.])" + _GPA_VAL + r"(?!\d)"
_CGPA_FWD = re.compile(r"(?:c\.?g\.?p\.?a\.?)[^\d]{0,6}" + _GPA_VAL + r"(?!\d)", re.I)
_CGPA_REV = re.compile(_GPA_VAL_REV + r"\s*(?:/\s*10)?\s*c\.?g\.?p\.?a\.?", re.I)
_GPA_FWD = re.compile(
    r"(?:gpa|grade\s*point(?:\s*average)?)[^\d]{0,6}" + _GPA_VAL + r"(?!\d)", re.I)
_GPA_REV = re.compile(_GPA_VAL_REV + r"\s*(?:/\s*10)?\s*gpa\b", re.I)


def _extract_gpa(t: str) -> float | None:
    for rx in (_CGPA_FWD, _CGPA_REV, _GPA_FWD, _GPA_REV):
        m = rx.search(t)
        if m:
            try:
                v = float(m.group(1))
                if 0 < v <= 10:
                    return round(v, 2)
            except ValueError:
                pass
    return None


def _clean_phone(raw: str) -> str | None:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 10 and digits[0] in "6789":
        return digits
    return None


# Profile links, as they appear on a resume: bare handles ("linkedin.com/in/x"),
# full URLs, or either wrapped in the icon-font debris a PDF text layer leaves.
_LINKEDIN_URL = re.compile(r"\b((?:https?://)?(?:www\.)?linkedin\.com/(?:in|pub)/[\w\-./%]+)", re.I)
_GITHUB_URL = re.compile(r"\b((?:https?://)?(?:www\.)?github\.com/[\w\-.]+)", re.I)
# Graduation year. Anchored on the words a resume actually uses, because a bare
# four-digit year matches a project date, a certification, or a phone fragment.
_GRAD_YEAR = re.compile(
    r"\b(?:expected\s+graduation|graduating|graduation|batch\s+of|class\s+of|"
    r"passing\s+out)\b[^0-9]{0,20}(20\d{2})",
    re.I,
)
# "2023 - Present" / "2023 – 2027" against a degree line: the second year is the
# graduation year when it is in the future.
_DEGREE_RANGE = re.compile(r"\b20\d{2}\s*[-–—]\s*(20\d{2})\b")
# The lookbehind keeps "B.Com" from matching inside "a@b.com" — an email address
# was being read as the candidate's degree and would have been typed into a
# "Qualification" box on a real form.
_DEGREE_LINE = re.compile(
    r"(?<![\w@.])((?:b\.?\s?tech|b\.?\s?e\.?|b\.?\s?sc|b\.?\s?com|b\.?\s?a\.?|bca|bba|"
    r"m\.?\s?tech|m\.?\s?sc|mca|mba|ph\.?\s?d|diploma)[^\n,;|]{0,60})",
    re.I,
)
# The institution name around the keyword, not the whole line: a resume writes
# "Anna University - B.E. Computer Science, expected graduation 2027, CGPA 8.7"
# on ONE line, and a line-anchored match returns either everything or nothing.
# [^\S\n] is "whitespace that isn't a newline". A plain \s+ let the match run
# backwards across the line break and swallow the candidate's own name off the
# line above — "Ankit Delhi University".
_COLLEGE_LINE = re.compile(
    r"\b((?:[A-Z][\w.&'-]+[^\S\n]+){0,4}(?:University|College|Institute)"
    r"(?:[^\S\n]+of[^\S\n]+[A-Z][\w.&'-]+(?:[^\S\n]+[A-Z][\w.&'-]+){0,2})?)"
)
# A personal site. Deliberately narrow: the first version accepted ".tech" and a
# one-character host, so it read "B.Tech" straight out of the education line and
# offered it as the candidate's portfolio — a degree, on its way into a real
# form's website box. The host must be at least three characters, and ".tech" is
# gone because "B.Tech" and "M.Tech" appear on nearly every Indian resume.
_PORTFOLIO_URL = re.compile(
    r"\b((?:https?://)?(?:www\.)?[\w-]{3,}\.(?:dev|me|io|xyz|site|page|app|portfolio)"
    r"(?:/[\w\-./%]*)?)", re.I,
)
# School results. Anchored on the level, because a bare percentage on a resume is
# just as likely to be a project metric ("improved throughput by 94%") — and a
# wrong number here is typed into a real eligibility box as fact.
#
# Both orders occur: "Class 12: 94%" and "94% - Class XII". The value is bounded
# to 0-100 by the caller; a CGPA written on the same line ("Class 12 - 9.4 CGPA")
# must not be read as a percentage, hence the explicit % or "percentage".
def _school_percent(t: str, level: str) -> float | None:
    names = {
        "12": r"(?:class\s*(?:12|xii)|12th|twelfth|intermediate|hsc|senior\s+secondary|\+2)",
        "10": r"(?:class\s*(?:10|x)\b|10th|tenth|ssc|matriculation|secondary)",
    }[level]
    forward = re.compile(
        names + r"[^\n%]{0,40}?(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent|percentage)", re.I)
    backward = re.compile(
        r"(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent|percentage)[^\n]{0,25}?" + names, re.I)
    for rx in (forward, backward):
        m = rx.search(t or "")
        if m:
            try:
                value = float(m.group(1))
            except ValueError:
                continue
            if 0 < value <= 100:
                return round(value, 2)
    return None


# A line that is a person's name and nothing else: resumes put it first, in
# title case, with no digits, no email and no job words. Deliberately strict —
# this becomes the name on every application, and "Curriculum Vitae" or
# "Software Engineer" arriving there is worse than asking.
_NAME_LINE = re.compile(r"^[A-Z][a-z'’.-]+(?:\s+[A-Z][a-z'’.-]+){1,3}$")
_NOT_A_NAME = re.compile(
    r"\b(resume|curriculum|vitae|profile|summary|objective|engineer|developer|"
    r"intern|student|manager|analyst|university|college|institute|linkedin|"
    r"github|email|phone|mobile|contact|address)\b",
    re.I,
)


def _extract_name(t: str) -> str | None:
    """The candidate's own name, off the top of the resume.

    Only the first few lines are considered: a name-shaped string further down is
    far more likely to be a referee, a manager, or a project's author. Nothing is
    returned unless a line is a name and only a name.
    """
    for raw in (t or "").splitlines()[:8]:
        line = re.sub(r"\s+", " ", raw).strip(" |•·—–-")
        if not line or len(line) > 48 or any(ch.isdigit() for ch in line):
            continue
        if "@" in line or _NOT_A_NAME.search(line):
            continue
        if _NAME_LINE.match(line):
            return line
    return None


def extract_contact(text: str, this_year: int | None = None,
                    links: list[str] | None = None) -> dict:
    """Everything a screening form asks that we can read off the resume itself.

    The point is that the user is never typed at twice: whatever the resume
    already states arrives in setup pre-filled, and they only confirm it. Every
    field is best-effort and conservative — None rather than a guess, because
    these become facts stated to employers (see agent/questions.py).

    `links` are URLs the file LINKS to without spelling out — a resume whose
    LinkedIn sits behind an icon states the address nowhere in its text, and no
    extractor will ever find it there. See resume_parse.pdf_links.

    Returns {name, phone, gpa, degree, college, grad_year, class10/12_percent,
    linkedin_url, github_url, portfolio_url}.
    """
    t = text or ""
    # Appended, not substituted: the text still wins for anything spelled out,
    # and the annotations only fill what it never said.
    if links:
        t = t + chr(10) + chr(10).join(links)
    phone = None
    m = _PHONE_ANCHORED.search(t) or _PHONE_LOOSE.search(t)
    if m:
        phone = _clean_phone(m.group(1))

    degree = None
    m = _DEGREE_LINE.search(t)
    if m:
        # Cut at the first bracket or grade marker: resumes run the degree and the
        # score together ("B.Tech in AI and ML (CGPA: 7.45)"), and the whole
        # string then goes into a form's "Qualification" box.
        degree = re.split(r"[(\[]|\b(?:cgpa|gpa|percentage)\b", m.group(1), maxsplit=1, flags=re.I)[0]
        degree = re.sub(r"\s+", " ", degree).strip(" .,-—–:")[:120] or None

    college = None
    m = _COLLEGE_LINE.search(t)
    if m:
        college = re.sub(r"\s+", " ", m.group(1)).strip(" .,-—–|")[:120] or None

    grad_year = None
    m = _GRAD_YEAR.search(t)
    if m:
        grad_year = int(m.group(1))
    else:
        # Fall back to the end of a degree's date range, but only when it hasn't
        # already passed — a finished course's end year is not a graduation date
        # anyone is still applying under, and a wrong year here is stated on a
        # form as fact.
        current = this_year or 0
        for candidate in _DEGREE_RANGE.findall(t):
            year = int(candidate)
            if current and year >= current:
                grad_year = year
                break

    def _url(pattern):
        found = pattern.search(t)
        return found.group(1).rstrip("/.,") if found else None

    portfolio = _url(_PORTFOLIO_URL)
    # linkedin.com and github.com both end in a TLD the portfolio pattern also
    # accepts on other hosts; without this the same link lands in two boxes.
    if portfolio and re.search(r"(linkedin|github)\.com", portfolio, re.I):
        portfolio = None

    return {
        "name": _extract_name(t),
        "phone": phone,
        "gpa": _extract_gpa(t),
        "degree": degree,
        "college": college,
        "grad_year": grad_year,
        # The two numbers every Indian internship form asks for and no other
        # field can supply — a college CGPA is a different number entirely.
        "class12_percent": _school_percent(t, "12"),
        "class10_percent": _school_percent(t, "10"),
        "linkedin_url": _url(_LINKEDIN_URL),
        "github_url": _url(_GITHUB_URL),
        "portfolio_url": portfolio,
    }






# ---------- fit: does this resume already work for this role? ----------





# ---------- internals ----------


def _coerce_advice(d: dict) -> dict:
    """Keep only the three word-lists, and drop anything numeric the model added.

    Models asked not to score will still occasionally return `score` or `grade`
    because every resume-review example they have ever seen has one. Silently
    passing that through would put a second, unmeasured number into a product
    whose entire pitch is that there is exactly one number and it is measured.
    So the keys are allow-listed rather than filtered — a new numeric field in a
    future model's output cannot leak through by default.
    """
    return {
        "strengths": _lst(d.get("strengths"), 4),
        "issues": _lst(d.get("issues"), 5),
        "suggestions": _lst(d.get("suggestions"), 5),
    }


def _ground_advice(advice: dict, source_text: str) -> dict:
    """Remove model lines that introduce unsupported tools or quantities.

    Prompt rules are guidance, not a boundary. A live launch evaluation asked
    the reviewer to use only existing facts and still received suggestions to
    name S3, SQS, Helm and Airflow when none appeared in the resume. That is
    especially dangerous in a resume product: a user can follow fluent advice
    straight into a false claim.

    The rewrite pipeline already maintains the broad technology vocabulary and
    morphology-aware source allow-list used by its fabrication gate. Reuse that
    boundary here. Quantities get the same treatment because a made-up metric is
    just as harmful as a made-up skill. Ordinary editorial language remains
    free; only concrete claims are constrained.
    """
    try:
        import resume_optimize

        allowed = resume_optimize._allowed_tokens(source_text, [])
        source_numbers = set(re.findall(r"\d+(?:[.,]\d+)*", source_text or ""))

        def supported(line: str) -> bool:
            fake = {
                "name": "",
                "contact_line": "",
                "sections": [{
                    "heading": "Review",
                    "items": [{"head": "", "sub": "", "bullets": [line]}],
                }],
            }
            if resume_optimize._fabricated_skills(fake, allowed):
                return False
            mentioned_numbers = set(re.findall(r"\d+(?:[.,]\d+)*", line))
            if not mentioned_numbers <= source_numbers:
                return False

            # Technology vocabularies are necessarily incomplete. Proper names
            # are the safe second net: after the sentence-opening word, a
            # capitalised token such as Helm, Airflow, S3 or Snowflake must be
            # present in the source. Generic document terms are harmless.
            safe_terms = {"ats", "cv", "pdf", "url"}
            source_low = (source_text or "").lower()
            proper = re.findall(r"\b[A-Z][A-Za-z0-9.+#-]*\b", line)
            for token in proper[1:]:
                low = token.lower()
                if low not in safe_terms and not re.search(
                    r"(?<![a-z0-9])" + re.escape(low) + r"(?![a-z0-9])",
                    source_low,
                ):
                    return False
            return True

        return {
            key: [line for line in advice.get(key, []) if supported(line)]
            for key in ("strengths", "issues", "suggestions")
        }
    except Exception as e:  # noqa: BLE001 — review grounding must fail closed
        print(f"[advise] grounding failed: {e}")
        return {"strengths": [], "issues": [], "suggestions": []}


def _fallback_advice(text: str) -> dict:
    """Advice from rules, for when no provider answers.

    Deliberately overlaps very little with `readiness.score` findings: that
    function already tells the user their email is missing. Repeating it here
    would fill the advice panel with the same four lines the report above it
    just made. These are the softer, judgement-shaped notes a rule can still
    make honestly.
    """
    low = (text or "").lower()
    strengths: list[str] = []
    issues: list[str] = []
    suggestions: list[str] = []

    if re.search(r"\bgithub\.com|\bgitlab\.com", low):
        strengths.append("Links to code a reviewer can actually open")
    else:
        suggestions.append(
            "Add a GitHub link so a reviewer can read the code behind your projects"
        )

    if re.search(r"\b(intern|internship|trainee)\b", low):
        strengths.append("Real industry exposure, not only coursework")
    if re.search(r"\b(led|managed|mentored|organised|organized)\b", low):
        strengths.append("Shows responsibility beyond individual tasks")

    if not re.search(r"\b(award|winner|rank|hackathon|scholarship|patent|publication)\b", low):
        suggestions.append(
            "If you have a rank, award, hackathon result, patent or publication, "
            "add it — it is the fastest credibility signal on the page"
        )
    if re.search(r"\bresponsible for\b|\bworked on\b", low):
        issues.append("Some bullets describe duties rather than outcomes")
        suggestions.append(
            "Replace 'Responsible for' and 'Worked on' with what you built and what changed"
        )

    if len(text or "") < 400:
        issues.append("Very little detail for a reviewer to judge")
        suggestions.append(
            "Give each project two or three bullets: the tools, what you built, and the result"
        )

    return {
        "strengths": strengths or ["Your resume was read successfully"],
        "issues": issues or ["Nothing beyond what the readiness report already lists"],
        "suggestions": suggestions or [
            "Lead every bullet with a past-tense action verb",
            "Put a real number in any bullet where you know one",
        ],
    }


def _lst(v: object, max_n: int) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v[:max_n] if str(x).strip()]
    return []


def advise(resume_text: str) -> dict:
    """Prose advice on a resume. See `_advise_uncached`.

    NOT CACHED, and the reason is worth keeping: `_advise_uncached` always
    returns a well-formed dict, filling it from a heuristic fallback when no
    provider answers. Nothing in that shape distinguishes "a model read this
    resume" from "every provider was rate-limited", so a cache would happily
    store one bad minute and serve it for a week — and the panel it feeds tells
    the user they are reading a model's opinion.

    The benefit it would buy is close to zero anyway: the result is persisted
    per-resume in `Resume.adviceJson`, and the button that calls this is only
    offered when that column is empty.
    """
    return _advise_uncached(resume_text)
