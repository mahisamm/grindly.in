"""Resume intelligence — analysis, fit scoring, and per-job tailoring.

analyze(text)              -> dict  score/grade/strengths/issues/suggestions
fit_score(text, job, jd)   -> int   how well the MASTER resume already covers a role
tailor(text, ...)          -> str   plain-text rewrite (legacy; no template fidelity)
tailor_latex(tex, ...)     -> str   the user's own .tex with ONLY Skills/Hobbies rewritten
to_pdf(text, path)         -> bool  write PDF; requires fpdf2 (pip install fpdf2)
"""
from __future__ import annotations
import json
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

_TAILOR_SYS = (
    "You are a careful resume editor. Make MINIMAL targeted edits to a resume for a specific role. "
    "STRICT rules you must follow: "
    "1. NEVER add a skill, tool, language, or framework not already present in the original resume. "
    "2. NEVER change dates, company names, job titles, or GPA. "
    "3. If the resume already matches the role well, return it COMPLETELY UNCHANGED. "
    "4. Only allowed changes: reorder bullet points to put most relevant first, "
    "   minor wording tweaks to highlight relevant existing experience. "
    "5. The output must look 95%+ identical to the input — small, surgical edits only. "
    "6. Output ONLY the resume text. No commentary, no JSON, no explanation."
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
    result = llm_mod.chat_json_ensemble(prompt, system=_ANALYZE_SYS, n=3, timeout=60)
    if result and isinstance(result, dict) and "score" in result:
        try:
            return _coerce(result)
        except (ValueError, TypeError):
            pass
    return _fallback_analysis(text)


def tailor(
    resume_text: str,
    job_title: str,
    company: str,
    job_skills: list[str],
    job_description: str = "",
    master_skills: list[str] | None = None,
) -> str:
    """Return resume tailored for a specific role. Falls back to original if LLM unavailable.

    Truthfulness guard: the tailored output is run through `_constrain_skills`,
    which strips any skill keyword from an explicit Skills line that the
    candidate's original resume / master skill set does not support. Tailoring
    may re-order and emphasize — it must never invent skills the user can't back
    up in an interview.
    """
    text = (resume_text or "").strip()
    if not text:
        return text

    job_ctx = f"Target role: {job_title} at {company}."
    if job_skills:
        job_ctx += f" Required skills: {', '.join(job_skills[:8])}."
    if job_description:
        job_ctx += f" Role description: {job_description[:400]}"

    prompt = (
        f"{job_ctx}\n\n"
        f"Original resume:\n\"\"\"\n{text[:5000]}\n\"\"\"\n\n"
        "Rewrite this resume tailored for the role above. Do NOT add skills, tools, "
        "or experience that are not already present. Output resume text only."
    )
    out = llm_mod.chat(prompt, system=_TAILOR_SYS, timeout=90)
    if out and len(out.strip()) > 100:
        return _constrain_skills(out.strip(), text, master_skills or [])
    return text  # LLM unavailable — original unchanged is fine


# ---------- ATS: what a machine actually reads off the page ----------

# Below this, no meaningful text came out of the file. A recruiter's ATS runs the
# same kind of extractor we do — so if pdfminer sees nothing, the ATS sees nothing,
# and the application is discarded before a human is ever involved.
_ATS_MIN_CHARS = 220

_EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+\.\w+\b")
_PHONE_RE = re.compile(r"(?:\+?\d[\d\s-]{7,}\d)")


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

    out = llm_mod.chat_json_ensemble(prompt, system=_LATEX_SYS, n=1, timeout=90)
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


def _constrain_skills(tailored: str, original: str, master_skills: list[str]) -> str:
    """Remove fabricated skill keywords from explicit 'Skills:' lines.

    Conservative: only edits lines that look like a skills list. A skill token is
    kept only if it appears in the original resume text or the master skill set.
    Anything else (an LLM-invented competency) is dropped, with a logged warning.
    """
    allowed = {s.strip().lower() for s in master_skills if s.strip()}
    orig_low = (original or "").lower()
    dropped: list[str] = []
    out_lines: list[str] = []

    for line in tailored.split("\n"):
        stripped = line.strip()
        low = stripped.lower()
        is_skills_line = bool(re.match(r"^(technical\s+skills|skills|tech\s+stack|core\s+competencies)\s*[:\-]", low))
        if is_skills_line and (":" in stripped or "-" in stripped):
            head, _, tail = stripped.partition(":")
            if not tail:
                head, _, tail = stripped.partition("-")
            tokens = re.split(r"[,/|•]", tail)
            kept = []
            for tok in tokens:
                t = tok.strip()
                if not t:
                    continue
                tl = t.lower()
                if tl in allowed or tl in orig_low or any(w in orig_low for w in tl.split()):
                    kept.append(t)
                else:
                    dropped.append(t)
            out_lines.append(f"{head}: " + ", ".join(kept))
        else:
            out_lines.append(line)

    if dropped:
        print(f"[resume_ai] truthfulness guard dropped unsupported skills: {dropped}")
    return "\n".join(out_lines)


def to_pdf(text: str, output_path: str) -> bool:
    """Write resume text to a PDF. Returns True on success. Requires: pip install fpdf2"""
    try:
        from fpdf import FPDF  # fpdf2

        pdf = FPDF()
        pdf.set_margins(18, 18, 18)
        pdf.add_page()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.set_font("Helvetica", size=10)

        for raw in (text or "").split("\n"):
            line = raw.strip()
            if not line:
                pdf.ln(2)
                continue
            clean = _ascii_only(line)
            if (line.isupper() and len(line) < 60) or (len(line) < 55 and line.endswith(":")):
                pdf.ln(2)
                pdf.set_font("Helvetica", "B", 11)
                pdf.cell(0, 6, clean, new_x="LMARGIN", new_y="NEXT")
                pdf.set_font("Helvetica", size=10)
            elif line.startswith(("- ", "• ", "* ")):
                pdf.cell(4, 5, "")
                pdf.multi_cell(0, 5, "• " + _ascii_only(line[2:]))
            else:
                pdf.multi_cell(0, 5, clean)

        os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
        pdf.output(output_path)
        return True
    except ImportError:
        print("[resume_ai] fpdf2 not installed — run: pip install fpdf2")
        return False
    except Exception as e:  # noqa: BLE001
        print(f"[resume_ai] PDF write error: {e}")
        return False


# ---------- internals ----------

def _ascii_only(s: str) -> str:
    return re.sub(r"[^\x20-\x7E]", "", s)


def _coerce(d: dict) -> dict:
    score = max(0, min(100, int(d.get("score") or 0)))
    return {
        "score": score,
        "grade": str(d.get("grade") or _grade(score)),
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
