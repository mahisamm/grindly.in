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

def generate_variants(
    source_text: str, master_skills: list[str], debug_dir: str | None = None
) -> dict:
    """Produce up to 3 compiled, measured resume variants + why any were dropped.

    Returns {"variants": [...], "baseline": int, "reasons": [str], "aborted": str|None}.
    `variants` is best-score-first, each:
        {label, score, grade, baseline_score, beats_baseline, changes: [str], pdf_bytes: bytes}

    Variants that scored at or below the master are KEPT and flagged
    beats_baseline=False rather than discarded. Dropping them silently is what
    produced "we couldn't beat your resume, so here is nothing" for a beta user
    who explicitly wanted to SEE the rewrites; the UI can label a non-winner, but
    it can't show a row that was thrown away. Only unreadable/unsafe ones die.

    `reasons` is the per-variant audit trail (kept / dropped and why) so the user
    and the admin get a real explanation instead of a guess at their resume being
    too good. `debug_dir`, when set, receives the .tex + .pdf of any variant whose
    compiled output couldn't be parsed — the only way to diagnose that offline.

    An empty variant list is a valid outcome, but `aborted`/`reasons` say WHICH
    kind: nothing beat the master, versus the LLM or the compiler never worked.
    Those are different messages to a user and the caller must not conflate them.
    """
    text = (source_text or "").strip()
    if len(text) < 200:
        print("[optimize] source too short to rebuild safely")
        return {"variants": [], "baseline": 0, "reasons": [], "aborted": "source_too_short"}
    if not latex_resume.tectonic_available():
        print("[optimize] tectonic not installed — cannot compile variants")
        return {"variants": [], "baseline": 0, "reasons": [], "aborted": "no_compiler"}

    # Re-score the master NOW, with the same providers this batch will use, so the
    # ">baseline" comparison is apples-to-apples rather than against a stored score
    # produced by a different provider mix on a different day.
    baseline = resume_ai.with_ats(resume_ai.analyze(text), text, master_skills)
    baseline_score = int(baseline.get("score") or 0)
    print(f"[optimize] baseline (re-scored) = {baseline_score}")

    base_struct = _extract_struct(text)
    if not base_struct:
        print("[optimize] structured extraction failed — aborting")
        return {
            "variants": [], "baseline": baseline_score,
            "reasons": [], "aborted": "extraction_failed",
        }

    allowed = _allowed_tokens(text, master_skills)

    out: list[dict] = []
    reasons: list[str] = []
    for label, instruction in _STRATEGIES:
        variant, reason = _one_variant(
            label, instruction, base_struct, allowed, master_skills, baseline_score, debug_dir
        )
        reasons.append(reason)
        if variant:
            out.append(variant)

    # Winners first, then near-misses by score. A variant that ties or loses is
    # still shown (flagged), so the user always has something to look at.
    out.sort(key=lambda v: (v["beats_baseline"], v["score"]), reverse=True)
    return {
        "variants": out[:3],
        "baseline": baseline_score,
        "reasons": reasons,
        "aborted": None,
    }


# ---------------- one variant ----------------

def _one_variant(
    label: str,
    instruction: str,
    base_struct: dict,
    allowed: set[str],
    master_skills: list[str],
    baseline_score: int,
    debug_dir: str | None = None,
) -> tuple[dict | None, str]:
    """Build one variant. Returns (variant_or_None, human-readable reason).

    The reason string is not decoration — it is what the user is told when the
    batch produces nothing, and it is the only signal that separates "your resume
    is already strong" from "our compiler produced an unreadable PDF".
    """
    rewritten = _rewrite_struct(base_struct, instruction, master_skills)
    if not rewritten:
        print(f"[optimize] {label}: rewrite produced nothing")
        return None, f"{label}: the rewrite step returned nothing (model unavailable)"
    raw_struct = rewritten.get("resume") if isinstance(rewritten.get("resume"), dict) else rewritten
    # Sanitize the REWRITE too, not just the extraction. _extract_struct returns
    # _sanitize_struct(out); this path returned the model's JSON untouched and
    # handed it straight to _render_latex. A response with "bullets" as a plain
    # string instead of a list is then iterated character by character, emitting
    # one \item per letter: the section's content vanishes, the PDF still
    # compiles, it clears the length check, gets scored, stored, and is offered
    # to the user behind a button that overwrites their real master resume.
    struct = _sanitize_struct(raw_struct) if isinstance(raw_struct, dict) else None
    if not struct:
        print(f"[optimize] {label}: rewrite came back malformed")
        return None, f"{label}: the rewrite came back in a shape we couldn't use"
    changes = _clean_changes(rewritten.get("changes"))

    invented = _fabricated_skills(struct, allowed)
    if invented:
        print(f"[optimize] {label}: truthfulness gate rejected invented skill(s): {invented}")
        return None, f"{label}: dropped — it invented skills you don't have ({', '.join(sorted(invented))})"

    tex = _render_latex(struct)
    if latex_resume.unsafe_commands(tex):
        print(f"[optimize] {label}: rendered tex tripped the unsafe-command denylist — skipping")
        return None, f"{label}: dropped by the LaTeX safety check"

    with tempfile.TemporaryDirectory(prefix="grindly-opt-") as tmp:
        pdf_path = os.path.join(tmp, "variant.pdf")
        result = latex_resume.compile_report(tex, pdf_path)
        if not result.ok or not os.path.exists(pdf_path):
            print(f"[optimize] {label}: compile failed")
            _dump_debug(debug_dir, label, tex, None)
            return None, f"{label}: the document didn't compile"
        if result.pages and result.pages > _MAX_PAGES:
            print(f"[optimize] {label}: {result.pages} pages — over the {_MAX_PAGES}-page cap")
            return None, f"{label}: came out {result.pages} pages, over the {_MAX_PAGES}-page limit"

        # Score what a parser actually reads off the compiled PDF, not the tex.
        parsed = resume_parse.extract_text(pdf_path)
        n_chars = len((parsed or "").strip())
        if n_chars < 200:
            # Our bug, not the user's resume. Keep the evidence: without the tex
            # and the pdf there is no way to tell an empty render from a font
            # that carries no extractable text.
            print(f"[optimize] {label}: compiled PDF yields only {n_chars} chars of text — rejecting")
            _dump_debug(debug_dir, label, tex, pdf_path)
            return None, f"{label}: the compiled PDF came out unreadable ({n_chars} chars) — a bug on our side"
        scored = resume_ai.with_ats(resume_ai.analyze(parsed), parsed, master_skills)
        score = int(scored.get("score") or 0)
        beats = score > baseline_score

        with open(pdf_path, "rb") as f:
            pdf_bytes = f.read()

    if beats:
        print(f"[optimize] {label}: kept ({score} > {baseline_score})")
        reason = f"{label}: {score} vs your {baseline_score} — kept"
    else:
        print(f"[optimize] {label}: kept for preview ({score} <= baseline {baseline_score})")
        reason = f"{label}: {score} vs your {baseline_score} — shown for preview, not an improvement"
    return {
        "label": label,
        "score": score,
        "grade": scored.get("grade") or resume_ai._grade(score),
        "baseline_score": baseline_score,
        "beats_baseline": beats,
        "changes": changes,
        "pdf_bytes": pdf_bytes,
    }, reason


def _dump_debug(debug_dir: str | None, label: str, tex: str, pdf_path: str | None) -> None:
    """Save the artefacts of a variant that failed to compile or parse.

    Best-effort and silent on failure — a debugging aid must never be able to
    take down the run it is trying to explain.
    """
    if not debug_dir:
        return
    try:
        os.makedirs(debug_dir, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "variant"
        with open(os.path.join(debug_dir, f"{slug}.tex"), "w", encoding="utf-8") as f:
            f.write(tex)
        if pdf_path and os.path.exists(pdf_path):
            with open(pdf_path, "rb") as src, open(os.path.join(debug_dir, f"{slug}.pdf"), "wb") as dst:
                dst.write(src.read())
        print(f"[optimize] {label}: debug artefacts written to {debug_dir}")
    except Exception as e:  # noqa: BLE001
        print(f"[optimize] {label}: could not write debug artefacts ({e})")


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

def _coerce_bullets(raw: object) -> list[str]:
    """Bullets, from whatever the model actually returned.

    A plain string is ONE bullet, never an iterable of characters. Iterating it
    is the bug this whole path exists to stop: `[b for b in "Python, React"]`
    emits one \\item per letter, which still compiles, still clears the length
    check, and reaches the user as a resume of single characters.
    """
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        # Models often pack several bullets into one string.
        parts = [p.strip(" -•\t") for p in re.split(r"[\r\n]+|(?<=[.;])\s{2,}", text)]
        return [p for p in parts if p][:_MAX_BULLETS]
    if isinstance(raw, list):
        return [str(b).strip() for b in raw if str(b).strip()][:_MAX_BULLETS]
    return []


def _coerce_items(raw: object) -> list[dict]:
    """Items, tolerant of the shapes models actually emit."""
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list):
        return []
    items: list[dict] = []
    for it in raw[:_MAX_ITEMS]:
        if isinstance(it, str):
            # A bare string is a bullet with no heading — common for SKILLS.
            bullets = _coerce_bullets(it)
            if bullets:
                items.append({"head": "", "sub": "", "bullets": bullets})
            continue
        if not isinstance(it, dict):
            continue
        items.append({
            "head": str(it.get("head") or it.get("title") or "").strip(),
            "sub": str(it.get("sub") or it.get("subtitle") or "").strip(),
            # "content"/"points" are the aliases seen most often after "bullets".
            "bullets": _coerce_bullets(
                it.get("bullets") if it.get("bullets") is not None
                else it.get("content") if it.get("content") is not None
                else it.get("points")
            ),
        })
    return items


def _sanitize_struct(struct: dict) -> dict | None:
    """Coerce an LLM struct into the exact shape _render_latex expects.

    Tolerant on purpose. Strictly dropping every off-shape response meant a
    model that returned items as plain strings, bullets as one string, or
    sections as a dict lost all its content — the render then produced a
    ~100-character .tex, the compiled PDF tripped the readability check, and the
    user was told "the compiled PDF came out unreadable — a bug on our side" for
    all three variants. Observed live.

    Coercing keeps the content while still refusing to iterate a string into
    per-character bullets, which is the failure that actually reaches a
    recruiter.
    """
    name = str(struct.get("name") or "").strip()
    contact = str(struct.get("contact_line") or struct.get("contact") or "").strip()
    sections_in = struct.get("sections")

    # {"SKILLS": [...], "PROJECTS": [...]} instead of a list of sections.
    if isinstance(sections_in, dict):
        sections_in = [
            {"heading": k, "items": v} for k, v in sections_in.items()
        ]

    sections: list[dict] = []
    if isinstance(sections_in, list):
        for sec in sections_in[:_MAX_SECTIONS]:
            if not isinstance(sec, dict):
                continue
            heading = str(sec.get("heading") or sec.get("title") or "").strip()
            if not heading:
                continue
            items = _coerce_items(
                sec.get("items") if sec.get("items") is not None else sec.get("content")
            )
            sections.append({"heading": heading, "items": items})

    # A struct whose sections all came back empty is not usable — rendering it
    # produces a near-blank page, which is worse than reporting nothing.
    if not any(s["items"] for s in sections):
        return None
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
