"""Resume intelligence — analysis, fit scoring, and per-job tailoring.

analyze(text)              -> dict  score/grade/strengths/issues/suggestions
fit_score(text, job, jd)   -> int   how well the MASTER resume already covers a role
tailor_latex(tex, ...)     -> str   the user's own .tex with ONLY Skills/Hobbies rewritten

There is deliberately no plain-text tailor()/to_pdf() any more. That path
re-rendered the whole resume from scratch with fpdf2, throwing away the user's
college-mandated template — the exact "looks patched together" output the LaTeX
path exists to prevent. The only sanctioned edit is tailor_latex: the user's own
.tex, with Skills/Hobbies rewritten and every other byte spliced back untouched.
"""
from __future__ import annotations
import os
import re

import latex_resume
import llm as llm_mod

# Above this, the master resume already sells the candidate for the role and is
# sent UNTOUCHED. Every edit risks the layout and costs an LLM call, so the
# default posture is to leave the resume alone and only intervene when the master
# genuinely under-sells — which is what makes the "which resume did they see?"
# record on the applications page meaningful rather than noise.
TAILOR_THRESHOLD = int(os.environ.get("GRINDLY_TAILOR_THRESHOLD", "75"))


# ---------- prompts ----------

_ANALYZE_SYS = (
    "You are a senior HR professional and ATS expert. "
    "Score the resume 0-100 based on: ATS-friendliness, completeness, clarity, "
    "keyword density, formatting, and impact of achievements. "
    "Return ONLY valid JSON with exactly these keys: "
    "score (int 0-100), grade (string A/B/C/D/F), "
    "strengths (array of 2-4 short strings), "
    "issues (array of 2-5 short strings — what is missing or weak), "
    "suggestions (array of 3-5 actionable one-sentence improvements). "
    "No markdown, no prose outside the JSON object."
)

# ---------- public API ----------

def analyze(resume_text: str) -> dict:
    """Score and analyze a resume. Always returns a dict; uses heuristics if LLM unavailable."""
    text = (resume_text or "").strip()
    if not text:
        return _fallback_analysis("")

    prompt = (
        f"Resume:\n\"\"\"\n{text[:6000]}\n\"\"\"\n\n"
        "Score and analyze this resume. Return valid JSON only."
    )
    # temperature=0.0: scoring is an evaluation, not a creative task. The same
    # resume must land on the same score every run — otherwise "Re-analyze" swings
    # 80→88→90 on identical input and the number reads as noise. The median-of-3
    # ensemble merge still smooths the small residual disagreement between models.
    result = llm_mod.chat_json_ensemble(
        prompt, system=_ANALYZE_SYS, n=3, timeout=60, temperature=0.0)
    if result and isinstance(result, dict) and "score" in result:
        try:
            return _coerce(result)
        except (ValueError, TypeError):
            pass
    return _fallback_analysis(text)


# ---------- ATS: what a machine actually reads off the page ----------

# Below this, no meaningful text came out of the file. A recruiter's ATS runs the
# same kind of extractor we do — so if pdfminer sees nothing, the ATS sees nothing,
# and the application is discarded before a human is ever involved.
_ATS_MIN_CHARS = 220

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.\w+\b")
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


def ats_report(resume_text: str, skills: list[str]) -> dict:
    """What survives machine extraction — which is all an ATS ever sees.

    This is deliberately not an LLM's opinion of the resume. It is a mechanical
    check of the text we could actually pull out of the file, and it catches the
    one failure that silently sinks every single application: a resume exported as
    a scan or an image, which looks perfect to a human and is empty to a parser.

    Returns {readable, chars, warnings}. Warnings are hard problems, not style
    notes, so callers surface them ahead of any LLM suggestion.
    """
    text = (resume_text or "").strip()
    chars = len(text)
    warnings: list[str] = []
    readable = chars >= _ATS_MIN_CHARS

    if not readable:
        warnings.append(
            "An applicant tracking system cannot read this resume — almost no text "
            "could be extracted from the file. It is most likely a scan, an image, or "
            "an export with embedded fonts. Re-export a text-based PDF; a recruiter's "
            "system will otherwise see a blank page."
        )
        return {"readable": False, "chars": chars, "warnings": warnings}

    if not _EMAIL_RE.search(text):
        warnings.append(
            "No email address could be parsed out of the file. Recruiters' systems "
            "pull contact details automatically — if yours is inside an image or a "
            "text box, you may never be contacted."
        )
    if not _PHONE_RE.search(text):
        warnings.append("No phone number could be parsed out of the file.")

    if skills:
        low = text.lower()
        unreadable = [
            s for s in skills
            if not re.search(r"(?<![a-z])" + re.escape(s.lower()) + r"(?![a-z])", low)
        ]
        # Only a real signal when MOST of the skills are unfindable — a couple of
        # misses is just the extractor being imperfect.
        if len(unreadable) > len(skills) * 0.6:
            warnings.append(
                "Most of your skills aren't findable in the extracted text — they may "
                "be inside a graphic, a table, or a two-column layout that parsers "
                "mangle. Keyword matching is how you get shortlisted."
            )

    return {"readable": True, "chars": chars, "warnings": warnings}


def with_ats(analysis: dict, resume_text: str, skills: list[str]) -> dict:
    """Merge the mechanical ATS findings into an LLM analysis.

    ATS warnings go to the FRONT of the issue list and cap the score: a beautifully
    written resume that no parser can read is not an 82/100 resume, whatever a
    language model thinks of the prose.
    """
    ats = ats_report(resume_text, skills)
    out = dict(analysis)
    out["ats"] = ats
    if ats["warnings"]:
        out["issues"] = ats["warnings"] + list(out.get("issues") or [])
    if not ats["readable"]:
        out["score"] = min(int(out.get("score") or 0), 35)
        out["grade"] = _grade(out["score"])
    return out


# ---------- fit: does this resume already work for this role? ----------

def _requirements(job: dict, jd_text: str) -> list[str]:
    """What the role actually asks for: the listing's declared skills, plus any
    known skill named in the job description."""
    req = [str(s).strip().lower() for s in (job.get("skills") or []) if str(s).strip()]
    if jd_text:
        import resume_parse

        low = jd_text.lower()
        for sk in resume_parse.KNOWN_SKILLS:
            if re.search(r"(?<![a-z])" + re.escape(sk) + r"(?![a-z])", low) and sk not in req:
                req.append(sk)
    return req[:20]


def fit_score(resume_text: str, job: dict, jd_text: str = "") -> int:
    """0-100: how well the resume AS IT STANDS covers this role.

    Deliberately NOT matcher.score_job(). That one scores the candidate's
    extracted skill LIST against the job and decides whether to apply at all — so
    by construction every job we reach here has already cleared it, and reusing it
    would mean the resume never got tailored. This scores the resume DOCUMENT: are
    the things this role asks for actually visible on the page a recruiter reads?

    Returns 100 when the role declares no requirements we can read — there is
    nothing to tailor toward, so the master resume goes out untouched.
    """
    text = (resume_text or "").strip().lower()
    if not text:
        return 0

    req = _requirements(job, jd_text)
    if not req:
        return 100

    hits = [
        r for r in req
        if re.search(r"(?<![a-z])" + re.escape(r) + r"(?![a-z])", text)
    ]
    coverage = len(hits) / len(req)

    semantic = _tfidf_score(text, jd_text) if jd_text else 0.0
    blended = 0.75 * coverage + 0.25 * min(1.0, semantic * 2.5)
    return int(round(max(0.0, min(1.0, blended)) * 100))


# ---------- LaTeX tailoring ----------

_LATEX_SYS = (
    "You are editing ONE section body of a LaTeX resume. "
    "You will be given the exact LaTeX source of that section body and a target role. "
    "STRICT rules: "
    "1. Return LaTeX that uses ONLY the macros and environments already present in the input. "
    "   Do not introduce new commands, new environments, \\section, or \\usepackage. "
    "2. NEVER add a skill, tool, language, or framework that is not in the allowed list given to you. "
    "   You may REORDER and you may REMOVE. You may not INVENT. "
    "3. Keep the same number of lines and the same structure. This must not change the page layout. "
    "4. If the section is already well-suited to the role, return it completely unchanged. "
    "Return ONLY valid JSON: {\"skills\": \"<latex>\", \"hobbies\": \"<latex>\"}. "
    "Omit a key entirely if you are not changing that section. No prose, no markdown."
)


def _latex_body_is_safe(new_body: str, old_body: str) -> bool:
    """Reject an LLM section body that would do more than rewrite that section."""
    if not new_body or not new_body.strip():
        return False
    # Structural macros would let the model escape its own section.
    for bad in (r"\section", r"\begin{document}", r"\end{document}", r"\usepackage",
                r"\documentclass", r"\input", r"\include"):
        if bad in new_body:
            print(f"[resume_ai] rejecting LaTeX edit: contains {bad}")
            return False
    if latex_resume.unsafe_commands(new_body):
        print("[resume_ai] rejecting LaTeX edit: unsafe command")
        return False
    if new_body.count("{") != new_body.count("}"):
        print("[resume_ai] rejecting LaTeX edit: unbalanced braces")
        return False
    # A body that ballooned is reflowing the page no matter what it claims.
    if len(new_body) > max(400, int(len(old_body) * 1.6)):
        print("[resume_ai] rejecting LaTeX edit: body grew too much")
        return False
    return True


def _no_invented_content(new_body: str, old_body: str, master_skills: list[str]) -> bool:
    """The truthfulness guard, at the LaTeX level. Every word-ish token in the new
    body must be something the candidate can actually defend: it was already in
    that section, or it is in their master skill set. Reordering and dropping
    are free; inventing is not — a fabricated skill is a wasted interview and a
    burnt reputation.

    Applies to EVERY editable section, not only Skills. Hobbies used to be
    accepted on structural checks alone, and the same prompt that writes it
    carries 400 characters of untrusted listing text — so "Hobbies: chess,
    photography" could come back as "AWS certification study group" and go to a
    recruiter with nothing between it and the PDF. The rule the system prompt
    already states ("You may REORDER and you may REMOVE. You may not INVENT")
    was only ever enforced on one of the two sections it was given."""
    allowed = set()
    for s in master_skills:
        allowed.update(re.findall(r"[a-z0-9+#.]+", s.lower()))
    allowed.update(re.findall(r"[a-z0-9+#.]+", old_body.lower()))

    for tok in re.findall(r"[A-Za-z][A-Za-z0-9+#.]{2,}", new_body):
        t = tok.lower()
        if t.startswith("\\"):
            continue
        if t not in allowed:
            print(f"[resume_ai] truthfulness guard: '{tok}' is not in the master resume — rejecting edit")
            return False
    return True


def tailor_latex(
    tex: str,
    job_title: str,
    company: str,
    job_skills: list[str],
    job_description: str = "",
    master_skills: list[str] | None = None,
) -> str | None:
    """Return the user's .tex with ONLY its Skills/Hobbies bodies rewritten for
    this role, or None if nothing could be safely changed.

    None means "send the master resume as-is", which is always an acceptable
    outcome — the caller must never fabricate a substitute.
    """
    master_skills = master_skills or []
    editable = latex_resume.editable_sections(tex)
    if not editable:
        print("[resume_ai] no Skills/Hobbies section found in the .tex — leaving it alone")
        return None

    current = {slot: sec.body(tex) for slot, sec in editable.items()}
    ctx = f"Target role: {job_title} at {company}."
    if job_skills:
        ctx += f" The role asks for: {', '.join(job_skills[:8])}."
    if job_description:
        ctx += f" Role description: {job_description[:400]}"

    prompt = (
        f"{ctx}\n\n"
        f"Skills you are ALLOWED to use (the candidate's real skills — using anything "
        f"outside this list is forbidden): {', '.join(master_skills) or '(none extracted)'}\n\n"
        + "\n\n".join(
            f"Current LaTeX of the '{slot}' section body:\n\"\"\"\n{body}\n\"\"\""
            for slot, body in current.items()
        )
        + "\n\nReturn the JSON object described in your instructions."
    )

    out = llm_mod.chat_json_ensemble(prompt, system=_LATEX_SYS, n=3, timeout=90)
    if not isinstance(out, dict):
        return None

    edits: dict[str, str] = {}
    for slot, new_body in out.items():
        if slot not in current or not isinstance(new_body, str):
            continue
        old_body = current[slot]
        if new_body.strip() == old_body.strip():
            continue
        if not _latex_body_is_safe(new_body, old_body):
            continue
        if not _no_invented_content(new_body, old_body, master_skills):
            continue
        edits[slot] = new_body

    if not edits:
        return None
    return latex_resume.replace_bodies(tex, edits)


# ---------- internals ----------

def _tfidf_score(a: str, b: str) -> float:
    """Cosine similarity of two texts under a TF-IDF vectorizer, in [0, 1].

    The semantic backstop to fit_score's literal keyword coverage: it credits a
    resume that discusses the same things the job description does even when it
    doesn't repeat the exact skill tokens. Degrades to 0.0 (coverage-only scoring)
    when scikit-learn isn't installed or the texts share no vocabulary — a scoring
    helper must never be the thing that crashes an application run.
    """
    a, b = (a or "").strip(), (b or "").strip()
    if not a or not b:
        return 0.0
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity
    except ImportError:
        return 0.0
    try:
        m = TfidfVectorizer(stop_words="english").fit_transform([a, b])
        return float(cosine_similarity(m[0:1], m[1:2])[0][0])
    except Exception as e:  # noqa: BLE001
        print(f"[resume_ai] tfidf scoring skipped: {e}")
        return 0.0


def _coerce(d: dict) -> dict:
    score = max(0, min(100, int(d.get("score") or 0)))
    return {
        "score": score,
        # Grade is DERIVED from the final score, never taken from the model. After
        # the ensemble merges the median score, an LLM-supplied grade can disagree
        # with it (score 85 arriving labelled "B"); the score→grade map is the one
        # source of truth so the badge and the number can never contradict.
        "grade": _grade(score),
        "strengths": _lst(d.get("strengths"), 4),
        "issues": _lst(d.get("issues"), 5),
        "suggestions": _lst(d.get("suggestions"), 5),
    }


def _fallback_analysis(text: str) -> dict:
    has_email = bool(re.search(r"\b[\w.+-]+@[\w-]+\.\w+\b", text))
    has_edu = bool(re.search(
        r"\b(b\.?tech|b\.?e|mca|bca|degree|university|college|cgpa|gpa)\b", text, re.I
    ))
    has_tech = bool(re.search(
        r"\b(python|javascript|java|react|sql|aws|docker|node|git|flutter|kotlin)\b", text, re.I
    ))
    has_proj = bool(re.search(
        r"\b(project|built|developed|created|implemented|deployed|designed)\b", text, re.I
    ))
    has_linkedin = bool(re.search(r"linkedin\.com", text, re.I))
    has_github = bool(re.search(r"github\.com", text, re.I))

    score = 25
    issues: list[str] = []
    strengths: list[str] = []
    suggestions: list[str] = []

    if has_email:
        score += 10
        strengths.append("Contact information present")
    else:
        issues.append("No email address found")
        suggestions.append("Add email and phone number at the top of your resume")

    if has_edu:
        score += 15
        strengths.append("Education section present")
    else:
        issues.append("Education details missing or unclear")
        suggestions.append("Add degree name, college, year of graduation, and CGPA")

    if has_tech:
        score += 20
        strengths.append("Technical skills listed")
    else:
        issues.append("No technical skills section detected")
        suggestions.append("Add a dedicated Skills section listing your tech stack")

    if has_proj:
        score += 15
        strengths.append("Project or work experience mentioned")
    else:
        issues.append("No project or work experience described")
        suggestions.append("Add 2-3 projects with: tech used, your role, and measurable outcome")

    if not has_linkedin:
        suggestions.append("Add your LinkedIn profile URL to the header")
    if not has_github:
        suggestions.append("Add a GitHub link showcasing your projects")

    if len(text) < 400:
        score = max(0, score - 10)
        issues.append("Resume appears very short — add more detail")
        suggestions.append("Expand with specifics: technologies used, team size, impact (e.g. 'reduced latency by 40%')")

    return {
        "score": min(score, 100),
        "grade": _grade(min(score, 100)),
        "strengths": strengths or ["Resume uploaded successfully"],
        "issues": issues or ["No critical structural issues detected"],
        "suggestions": suggestions or [
            "Quantify achievements wherever possible",
            "Use strong action verbs to start each bullet point",
        ],
    }


def _grade(s: int) -> str:
    if s >= 85: return "A"
    if s >= 70: return "B"
    if s >= 55: return "C"
    if s >= 40: return "D"
    return "F"


def _lst(v: object, max_n: int) -> list[str]:
    if isinstance(v, list):
        return [str(x) for x in v[:max_n] if str(x).strip()]
    return []
