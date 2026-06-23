"""Resume intelligence — analysis, scoring, and per-job tailoring.

analyze(text)          -> dict  score/grade/strengths/issues/suggestions
tailor(text, ...)      -> str   resume rewritten for a specific role
to_pdf(text, path)     -> bool  write PDF; requires fpdf2 (pip install fpdf2)
"""
from __future__ import annotations
import os
import re

import llm as llm_mod


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
