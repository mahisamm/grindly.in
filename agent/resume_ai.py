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
# GPA value 0–10 only; the trailing (?!\d) stops "45.0" from being read as "4".
_CGPA_RE = re.compile(
    r"(?:c\.?g\.?p\.?a\.?|gpa|grade\s*point(?:\s*average)?)"
    r"[^\d]{0,6}(10(?:\.\d{1,2})?|[0-9](?:\.\d{1,2})?)(?!\d)", re.I)


def _clean_phone(raw: str) -> str | None:
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    if len(digits) == 10 and digits[0] in "6789":
        return digits
    return None


def extract_contact(text: str) -> dict:
    """Best-effort phone + GPA pulled off a resume, to prefill the form-fill profile
    fields. Conservative by design — returns None for anything it isn't reasonably
    sure of. Returns {"phone": str|None, "gpa": float|None}."""
    t = text or ""
    phone = None
    m = _PHONE_ANCHORED.search(t) or _PHONE_LOOSE.search(t)
    if m:
        phone = _clean_phone(m.group(1))
    gpa = None
    gm = _CGPA_RE.search(t)
    if gm:
        try:
            v = float(gm.group(1))
            if 0 < v <= 10:
                gpa = round(v, 2)
        except ValueError:
            pass
    return {"phone": phone, "gpa": gpa}


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


def _no_invented_skills(new_body: str, old_body: str, master_skills: list[str]) -> bool:
    """The truthfulness guard, at the LaTeX level. Every word-ish token in the new
    Skills body must be something the candidate can actually defend: it was already
    in that section, or it is in their master skill set. Reordering and dropping
    are free; inventing is not — a fabricated skill is a wasted interview and a
    burnt reputation."""
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
        if slot == "skills" and not _no_invented_skills(new_body, old_body, master_skills):
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
