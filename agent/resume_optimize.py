"""ATS-optimized resume variants — the "3 better resumes" feature.

Pipeline (all invisible to the user; they see scores + a plain-English change list):

    1. Extract the master resume text into a generic, template-agnostic structure
       (name, contact, sections -> items -> bullets) via one LLM call.
    2. Rewrite that structure three ways, each under a different ATS strategy. The
       rewrites may reword, reorder, tighten, and surface real keywords. They may
       NOT invent: a truthfulness gate rejects any variant that introduces a
       skill/tool/technology absent from the source before it is ever compiled.
    3. Render each surviving structure into a fixed, safe, single-column LaTeX
       template (ATS-friendly by construction — no columns, tables, or graphics
       for a parser to mangle) with every field escaped.
    4. Compile with Tectonic --untrusted, re-extract the text a recruiter's ATS
       would actually see, and re-score it with the SAME analyzer used on the
       master. Keep ONLY variants that scored strictly higher than the master —
       the "higher ATS score" claim is measured, never asserted.

Why a clean rebuild and not a clone of the user's PDF: an LLM cannot faithfully
reconstruct a multi-column college template's geometry/fonts from extracted text,
and those very templates are what parsers choke on (see resume_ai.ats_report).
Rebuilding onto a clean template is both the honest option and the one that
actually raises the score. When the user has uploaded their own .tex, the
per-job tailoring path (resume_ai.tailor_latex) already preserves it byte-for-
byte; this feature is the whole-document, opt-in, "show me better versions" path.
"""
from __future__ import annotations

import json
import os
import re
import tempfile

import latex_resume
import llm as llm_mod
import resume_ai
import resume_parse

# Keep the whole feature bounded — an intern resume is one page. These caps stop a
# runaway LLM response from producing a 6-page document or a pathological compile.
_MAX_SECTIONS = 7
_MAX_ITEMS = 8
_MAX_BULLETS = 6
_MAX_BULLET_CHARS = 240
_MAX_PAGES = 2  # a variant that spills past this isn't an ATS win, it's a mess

# Each strategy is (label, instruction). Order is display order before re-scoring
# re-sorts by measured score. Three genuinely different levers, none of which
# require inventing anything the candidate can't defend in an interview.
_STRATEGIES: list[tuple[str, str]] = [
    (
        "Keyword-optimized",
        "Surface the candidate's REAL skills and tools as exact, ATS-matchable "
        "keywords. Pull tools already implied by a bullet up into the bullet's "
        "wording and into the skills section. Use standard section names "
        "(Experience, Projects, Technical Skills, Education). Do not add any tool "
        "or skill the source does not already show.",
    ),
    (
        "Impact-focused",
        "Rewrite every bullet to lead with a strong past-tense action verb and to "
        "state the outcome. Keep any real numbers from the source and make them "
        "prominent. NEVER invent a metric, percentage, user count, or result that "
        "the source does not state — a fabricated number is a failed interview.",
    ),
    (
        "ATS-clean",
        "Tighten and de-clutter: remove filler words, fix inconsistent tense, use "
        "plain standard section headings, and make each bullet a single scannable "
        "line. Preserve every fact; change only wording and structure.",
    ),
]


# ---------------- public API ----------------

def generate_variants(source_text: str, master_skills: list[str]) -> list[dict]:
    """Produce up to 3 compiled, measured, higher-scoring resume variants.

    Returns a list of dicts (best score first), each:
        {label, score, grade, baseline_score, changes: [str], pdf_bytes: bytes}

    An empty list is a valid, honest outcome — it means nothing we could generate
    scored higher than the master, or the LLM/compiler was unavailable. The caller
    surfaces that as "no gain", never as an error and never as a worse resume.
    """
    text = (source_text or "").strip()
    if len(text) < 200:
        print("[optimize] source too short to rebuild safely")
        return []
    if not latex_resume.tectonic_available():
        print("[optimize] tectonic not installed — cannot compile variants")
        return []

    # Re-score the master NOW, with the same providers this batch will use, so the
    # ">baseline" comparison is apples-to-apples rather than against a stored score
    # produced by a different provider mix on a different day.
    baseline = resume_ai.with_ats(resume_ai.analyze(text), text, master_skills)
    baseline_score = int(baseline.get("score") or 0)
    print(f"[optimize] baseline (re-scored) = {baseline_score}")

    base_struct = _extract_struct(text)
    if not base_struct:
        print("[optimize] structured extraction failed — aborting")
        return []

    allowed = _allowed_tokens(text, master_skills)

    out: list[dict] = []
    for label, instruction in _STRATEGIES:
        variant = _one_variant(label, instruction, base_struct, allowed, master_skills, baseline_score)
        if variant:
            out.append(variant)

    out.sort(key=lambda v: v["score"], reverse=True)
    return out[:3]


# ---------------- one variant ----------------

def _one_variant(
    label: str,
    instruction: str,
    base_struct: dict,
    allowed: set[str],
    master_skills: list[str],
    baseline_score: int,
) -> dict | None:
    rewritten = _rewrite_struct(base_struct, instruction, master_skills)
    if not rewritten:
        print(f"[optimize] {label}: rewrite produced nothing")
        return None
    struct = rewritten.get("resume") if isinstance(rewritten.get("resume"), dict) else rewritten
    changes = _clean_changes(rewritten.get("changes"))

    invented = _fabricated_skills(struct, allowed)
    if invented:
        print(f"[optimize] {label}: truthfulness gate rejected invented skill(s): {invented}")
        return None

    tex = _render_latex(struct)
    if latex_resume.unsafe_commands(tex):
        print(f"[optimize] {label}: rendered tex tripped the unsafe-command denylist — skipping")
        return None

    with tempfile.TemporaryDirectory(prefix="grindly-opt-") as tmp:
        pdf_path = os.path.join(tmp, "variant.pdf")
        result = latex_resume.compile_report(tex, pdf_path)
        if not result.ok or not os.path.exists(pdf_path):
            print(f"[optimize] {label}: compile failed")
            return None
        if result.pages and result.pages > _MAX_PAGES:
            print(f"[optimize] {label}: {result.pages} pages — over the {_MAX_PAGES}-page cap")
            return None

        # Score what a parser actually reads off the compiled PDF, not the tex.
        parsed = resume_parse.extract_text(pdf_path)
        if not parsed or len(parsed.strip()) < 200:
            print(f"[optimize] {label}: compiled PDF yields no parseable text — rejecting")
            return None
        scored = resume_ai.with_ats(resume_ai.analyze(parsed), parsed, master_skills)
        score = int(scored.get("score") or 0)
        if score <= baseline_score:
            print(f"[optimize] {label}: {score} did not beat baseline {baseline_score} — dropping")
            return None

        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

    print(f"[optimize] {label}: kept ({score} > {baseline_score})")
    return {
        "label": label,
        "score": score,
        "grade": scored.get("grade") or resume_ai._grade(score),
        "baseline_score": baseline_score,
        "changes": changes,
        "pdf_bytes": pdf_bytes,
    }


# ---------------- LLM: extract + rewrite ----------------

_STRUCT_SCHEMA = (
    '{"name": string, "contact_line": string, "sections": ['
    '{"heading": string, "items": [{"head": string, "sub": string, '
    '"bullets": [string]}]}]}'
)

_EXTRACT_SYS = (
    "You convert a resume's raw text into a clean structured JSON object, losing "
    "no factual content. Output ONLY this JSON shape, nothing else:\n"
    + _STRUCT_SCHEMA
    + "\nRules: 'contact_line' is one line joining email, phone, location, and any "
    "GitHub/LinkedIn/portfolio URLs with ' | '. Group content into standard "
    "sections (Education, Experience, Projects, Technical Skills, and any others "
    "the resume clearly has). For a skills section, put each skill group as one "
    "bullet like 'Languages: Python, Java, SQL'. 'head' is a title (role, project "
    "name, or degree); 'sub' is the right-aligned meta (dates, company, tech, "
    "CGPA) or an empty string. Copy facts verbatim — do not add, embellish, or "
    "invent. No markdown, no prose outside the JSON."
)


def _extract_struct(text: str) -> dict | None:
    prompt = (
        f'Resume text:\n"""\n{text[:6000]}\n"""\n\n'
        "Return the structured JSON object described in your instructions."
    )
    out = llm_mod.chat_json_ensemble(prompt, system=_EXTRACT_SYS, n=3, timeout=90)
    return _sanitize_struct(out) if isinstance(out, dict) else None


_REWRITE_SYS = (
    "You are an expert ATS resume editor. You are given a resume as JSON and one "
    "optimization strategy. Rewrite the resume to raise its ATS score UNDER THAT "
    "STRATEGY, and return JSON of the form:\n"
    '{"resume": <same JSON schema as the input>, "changes": [<3-5 short strings, '
    "each naming one concrete improvement you made>]}\n"
    "ABSOLUTE RULES:\n"
    "1. Never invent, add, or imply a skill, tool, technology, company, job, "
    "degree, certification, or metric that is not already present in the input. "
    "You may reword, reorder, merge, split, and drop. You may not fabricate.\n"
    "2. Keep the exact same JSON schema (name, contact_line, sections[heading, "
    "items[head, sub, bullets]]).\n"
    "3. Keep 'name' and 'contact_line' factually identical to the input.\n"
    "4. Keep it to one page of content — be concise.\n"
    "No markdown, no prose outside the JSON object."
)


def _rewrite_struct(base_struct: dict, instruction: str, master_skills: list[str]) -> dict | None:
    skills_line = ", ".join(master_skills) if master_skills else "(none extracted)"
    prompt = (
        f"Strategy: {instruction}\n\n"
        f"The candidate's real, defensible skills (using anything outside this set "
        f"is forbidden): {skills_line}\n\n"
        f"Resume JSON to rewrite:\n{json.dumps(base_struct, ensure_ascii=False)[:6000]}\n\n"
        "Return the {\"resume\": ..., \"changes\": ...} JSON object."
    )
    out = llm_mod.chat_json_ensemble(prompt, system=_REWRITE_SYS, n=3, timeout=120)
    return out if isinstance(out, dict) else None


# ---------------- truthfulness gate ----------------

def _allowed_tokens(source_text: str, master_skills: list[str]) -> set[str]:
    """Every alnum-ish token the candidate can defend: it appears in their resume
    text, or it's in their extracted master skill set. A variant may use only
    these as skill/tool vocabulary."""
    allowed: set[str] = set(re.findall(r"[a-z0-9+#.]+", (source_text or "").lower()))
    for s in master_skills or []:
        allowed.update(re.findall(r"[a-z0-9+#.]+", s.lower()))
    return allowed


def _fabricated_skills(struct: dict, allowed: set[str]) -> list[str]:
    """Known tech skills that appear in the variant but NOT in the source — i.e.
    invented. Rewording English prose is fine; introducing 'kubernetes' or 'aws'
    the candidate never listed is not. We check against the curated KNOWN_SKILLS
    vocabulary so ordinary rewrite words don't trip the gate, only real skills do.
    """
    blob = _flatten(struct).lower()
    bad: list[str] = []
    for sk in resume_parse.KNOWN_SKILLS:
        present = re.search(r"(?<![a-z])" + re.escape(sk) + r"(?![a-z])", blob)
        if not present:
            continue
        # Is every token of this multi-word skill defensible from the source?
        if all(tok in allowed for tok in re.findall(r"[a-z0-9+#.]+", sk)):
            continue
        bad.append(sk)
    return bad


def _flatten(struct: dict) -> str:
    parts: list[str] = [str(struct.get("name") or ""), str(struct.get("contact_line") or "")]
    for sec in struct.get("sections") or []:
        parts.append(str(sec.get("heading") or ""))
        for item in sec.get("items") or []:
            parts.append(str(item.get("head") or ""))
            parts.append(str(item.get("sub") or ""))
            parts.extend(str(b) for b in (item.get("bullets") or []))
    return "\n".join(parts)


# ---------------- LaTeX render (fixed, safe template) ----------------

_ESCAPE = {
    "\\": r"\textbackslash{}",
    "&": r"\&", "%": r"\%", "$": r"\$", "#": r"\#",
    "_": r"\_", "{": r"\{", "}": r"\}",
    "~": r"\textasciitilde{}", "^": r"\textasciicircum{}",
}


def _esc(s: object) -> str:
    """Escape arbitrary user text for LaTeX. Backslash is handled first (it's the
    escape char itself) via the ordered single-pass replace below."""
    out = []
    for ch in str(s or ""):
        out.append(_ESCAPE.get(ch, ch))
    return "".join(out)


_PREAMBLE = (
    "\\documentclass[11pt]{article}\n"
    "\\usepackage[margin=0.65in]{geometry}\n"
    "\\setlength{\\parindent}{0pt}\n"
    "\\pagestyle{empty}\n"
    "\\begin{document}\n"
)


def _render_latex(struct: dict) -> str:
    """Render the structured resume into single-column LaTeX using only the core
    `geometry` package. No columns, tables, tikz, or custom fonts — the layout an
    ATS parses cleanly, by construction. All content is escaped via _esc()."""
    name = _esc(struct.get("name") or "")
    contact = _esc(struct.get("contact_line") or "")

    lines = [_PREAMBLE]
    # Header: name + contact, centered. The \par inside each group is what applies
    # the centering to that line.
    lines.append("{\\centering \\LARGE \\textbf{" + name + "}\\par}")
    if contact:
        lines.append("{\\centering \\small " + contact + "\\par}")
    lines.append("\\vspace{6pt}")

    for sec in (struct.get("sections") or [])[:_MAX_SECTIONS]:
        heading = _esc(sec.get("heading") or "")
        if not heading:
            continue
        # Heading + full-width rule. \hrulefill is horizontal-mode safe (unlike a
        # bare \hrule, which needs vertical mode); \par ends each line cleanly so a
        # rewrite can never leave the compiler mid-paragraph.
        lines.append("\\vspace{8pt}\\noindent{\\large \\textbf{" + heading + "}}\\par")
        lines.append("\\vspace{1pt}\\noindent\\hrulefill\\par")
        lines.append("\\vspace{3pt}")
        for item in (sec.get("items") or [])[:_MAX_ITEMS]:
            head = _esc(item.get("head") or "")
            sub = _esc(item.get("sub") or "")
            if head or sub:
                if head and sub:
                    lines.append("\\noindent\\textbf{" + head + "} \\hfill " + sub + "\\par")
                elif head:
                    lines.append("\\noindent\\textbf{" + head + "}\\par")
                else:
                    lines.append("\\noindent " + sub + "\\par")
            bullets = [b for b in (item.get("bullets") or []) if str(b).strip()][:_MAX_BULLETS]
            if bullets:
                lines.append("\\begin{itemize}")
                lines.append("\\setlength{\\itemsep}{1pt}\\setlength{\\parskip}{0pt}\\setlength{\\topsep}{2pt}")
                for b in bullets:
                    lines.append("\\item " + _esc(str(b)[:_MAX_BULLET_CHARS]))
                lines.append("\\end{itemize}")
            else:
                lines.append("\\vspace{2pt}")

    lines.append("\\end{document}\n")
    return "\n".join(lines)


# ---------------- sanitizers ----------------

def _sanitize_struct(struct: dict) -> dict | None:
    """Coerce an LLM struct into the exact shape _render_latex expects, dropping
    anything malformed. Returns None if there's no usable content at all."""
    name = str(struct.get("name") or "").strip()
    contact = str(struct.get("contact_line") or "").strip()
    sections_in = struct.get("sections")
    sections: list[dict] = []
    if isinstance(sections_in, list):
        for sec in sections_in[:_MAX_SECTIONS]:
            if not isinstance(sec, dict):
                continue
            heading = str(sec.get("heading") or "").strip()
            if not heading:
                continue
            items_in = sec.get("items")
            items: list[dict] = []
            if isinstance(items_in, list):
                for it in items_in[:_MAX_ITEMS]:
                    if not isinstance(it, dict):
                        continue
                    bullets_in = it.get("bullets")
                    bullets = (
                        [str(b).strip() for b in bullets_in if str(b).strip()][:_MAX_BULLETS]
                        if isinstance(bullets_in, list)
                        else []
                    )
                    items.append({
                        "head": str(it.get("head") or "").strip(),
                        "sub": str(it.get("sub") or "").strip(),
                        "bullets": bullets,
                    })
            sections.append({"heading": heading, "items": items})
    if not name and not sections:
        return None
    return {"name": name, "contact_line": contact, "sections": sections}


def _clean_changes(changes: object) -> list[str]:
    if not isinstance(changes, list):
        return []
    out: list[str] = []
    for c in changes:
        s = str(c).strip()
        if s and s not in out:
            out.append(s[:160])
        if len(out) >= 5:
            break
    return out
