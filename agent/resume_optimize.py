"""ATS-optimized resume variants — the "3 better resumes" feature.

Pipeline (all invisible to the user; they see scores + a plain-English change list):

    1. Extract the master resume text into a generic, template-agnostic structure
       (name, contact, sections -> items -> bullets) via one LLM call.
    2. Rewrite that structure three ways, each under a different ATS strategy. The
       rewrites may reword, reorder, tighten, and surface real keywords. They may
       NOT invent: three gates run before a variant is ever compiled —
         * skills:     no tool/technology absent from the source (_fabricated_skills)
         * grounding:  no company, school, or date whose words aren't in the source
         * provenance: every non-skills item must descend from a real item on the
                       master (a rewrite may reword an entry, never add one)
    3. Render each surviving structure into a fixed, safe, single-column LaTeX
       template (ATS-friendly by construction — no columns, tables, or graphics
       for a parser to mangle) with every field escaped.
    4. Compile with Tectonic --untrusted, re-extract the text a recruiter's ATS
       would actually see, and re-score it with the SAME analyzer used on the
       master. Keep ONLY variants that scored at least as high as the master —
       the "higher ATS score" claim is measured, never asserted.

Identity (name + contact line) is NEVER taken from the model. Outbound prompts
are PII-redacted at the LLM boundary (agent/redact.py), so the model literally
sees "[phone redacted] | [email redacted]" and — doing exactly as told — copies
those placeholders back. That shipped: a compiled variant whose header carried no
phone and no email, i.e. a resume no employer could reply to. Identity is now
lifted from the raw source text locally and stamped onto every variant after the
rewrite.

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
# Below this, the extraction didn't understand the resume. Rewriting from it is
# not "a thin variant" — it is a model being handed an empty document and asked to
# improve it, which it does by inventing a career. See _extract_struct.
_MIN_BASE_ITEMS = 3
# How far below the master a variant may land and still be shown, labelled as
# level rather than better.
#
# Calibrated against measurement, not taste. resume_ai.analyze already pins
# temperature to 0 and takes a median across providers, yet the SAME master resume
# re-scored 70, 76 and 88 on three consecutive runs — because which providers
# answer varies (one of the three errors intermittently), and the models disagree
# by ~15 points on the same document. So the estimator's own spread is roughly
# ±9, and any threshold tighter than that discards good rewrites on a coin flip:
# one run produced 90/87/76 against a 70 baseline, the next 85/78 against an 88.
#
# 6 is deliberately inside that spread rather than at its edge: wide enough that a
# rewrite isn't thrown away over noise, narrow enough that a materially worse
# document (the 35 against a 76 that started all this) still never appears.
_SCORE_NOISE = 6

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

# "Tighten and de-clutter" is the wrong instruction for a resume that is already
# thin. Measured on a 475-character fresher resume: the source scored 60 and all
# three rewrites scored 38-40 with the same facts, no ATS warnings, and fewer
# characters than they started with. There was no clutter to cut — compression
# just removed the little substance the document had. Under this length, the third
# strategy draws out what is already on the page instead of trimming it.
_SHORT_SOURCE_CHARS = 700
_SPARSE_BULLETS = 6
_EXPAND_STRATEGY = (
    "Detail-first",
    "This resume is very short, so do NOT shorten it. Draw out what is already "
    "there: give each project and role its own bullets naming the concrete tools, "
    "the task, and the outcome ALREADY stated or plainly implied by the source "
    "text. Split a run-on line into separate bullets. Name the technologies "
    "explicitly where the source names them. Add no fact, tool, number, employer, "
    "or outcome that the source does not contain — expand the wording, never the "
    "claims.",
)


def _strategies_for(text: str, base_struct: dict | None = None) -> list[tuple[str, str]]:
    """Swap the trim strategy for the expand one when there is nothing to trim.

    Judged on bullets, not characters. A dense mid-career resume can be under a
    thousand characters and still have plenty to tighten: one measured at 959
    chars scored 92, and trimming it (85) beat expanding it (80). What actually
    marks a resume as thin is how few things it says.
    """
    bullets = sum(
        len(item.get("bullets") or [])
        for sec in (base_struct or {}).get("sections") or []
        for item in sec.get("items") or []
    )
    sparse = bullets < _SPARSE_BULLETS if base_struct else len(text or "") < _SHORT_SOURCE_CHARS
    return _STRATEGIES[:2] + [_EXPAND_STRATEGY] if sparse else _STRATEGIES


# Sections whose items are regrouped freely by a rewrite ("Languages", "Frontend",
# "Databases" — groupings that exist on no master resume). Provenance can't apply
# to them; the skills gate (_fabricated_skills) covers their content instead.
_SKILLS_SECTION_RE = re.compile(
    r"skill|tool|technolog|language|framework|competenc|expertise|proficien|stack|abilities",
    re.I,
)

# Words that carry no fact, so they need no grounding. Deliberately short: every
# word NOT in here that appears in a company/school/date line must be traceable to
# the master resume.
_FREE_WORDS = frozenset({
    "and", "the", "for", "with", "from", "using", "into", "over", "under",
    "present", "current", "ongoing", "various", "other", "team", "role",
    "project", "projects", "experience", "education", "skills", "technical",
    "summary", "profile", "objective", "work", "position", "intern",
    "internship", "remote", "hybrid", "onsite", "full", "time", "part",
})


# ---------------- public API ----------------

def generate_variants(
    source_text: str,
    master_skills: list[str],
    debug_dir: str | None = None,
    contact_fallback: str = "",
) -> dict:
    """Produce up to 3 compiled, measured resume variants + why any were dropped.

    Returns {"variants": [...], "baseline": int, "reasons": [str], "aborted": str|None}.
    `variants` is best-score-first, each:
        {label, score, grade, baseline_score, beats_baseline, changes: [str], pdf_bytes: bytes}

    A variant that scores materially BELOW the master is discarded, not shown.
    Showing it was a deliberate earlier choice ("the user asked to see the
    rewrites") and it was wrong in practice: the card offered a 35/F rebuild
    beside the user's own 76, behind a button that would have made the worse
    document their master resume. A losing rewrite is noise wearing the same
    chrome as a win. It survives only in `reasons`.

    "Materially" is doing real work there — see _SCORE_NOISE. A variant level with
    the master is kept and flagged beats_baseline=False: same score on a clean,
    single-column template is a real (if modest) win for a parser, and the UI
    labels it as such.

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
    # An empty (or near-empty) base is a hard stop, not thin input. A rewriter
    # handed a resume with no content fills the gap from its own imagination and
    # returns a fluent, well-formatted, entirely fictional career — which then
    # scores well, because the scorer measures parseability, not truth.
    # Scaled to the document. Three items off a 4,000-character resume means the
    # extraction failed; three items off a 600-character fresher resume with one
    # internship and two projects means that IS the resume, and refusing it would
    # deny the feature to exactly the users who need it most. Inventing content is
    # still blocked either way — provenance drops any item with no ancestor.
    min_items = _MIN_BASE_ITEMS if len(text) >= 800 else 1
    if _item_count(base_struct) < min_items:
        print(f"[optimize] structured extraction kept only {_item_count(base_struct)} item(s) — aborting")
        return {
            "variants": [], "baseline": baseline_score,
            "reasons": [], "aborted": "extraction_failed",
        }

    # Identity comes from the raw resume, never from the model — see module
    # docstring. It is stamped onto each VARIANT, never onto base_struct: that one
    # is serialised into the rewrite prompt, and the redaction that keeps a phone
    # number out of a third-party API is a runtime setting (agent/redact.py), not
    # a guarantee. Don't put PII somewhere it only stays private if a flag holds.
    identity = _identity_from_source(text, contact_fallback)
    # How much of the master survived extraction bounds everything downstream: a
    # thin base can only produce thin, low-scoring variants, and from the outside
    # that is indistinguishable from a bad rewrite.
    print(f"[optimize] extracted {len(base_struct['sections'])} section(s), "
          f"{sum(len(s['items']) for s in base_struct['sections'])} item(s)")

    allowed = _allowed_tokens(text, master_skills)
    stems = _source_stems(text)

    out: list[dict] = []
    reasons: list[str] = []
    for label, instruction in _strategies_for(text, base_struct):
        variant, reason = _one_variant(
            label, instruction, base_struct, allowed, master_skills, baseline_score,
            identity, stems, debug_dir,
        )
        reasons.append(reason)
        if variant:
            out.append(variant)

    # Wins first, then ties. Losers never reach this list (_one_variant drops them).
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
    identity: tuple[str, str],
    stems: set[str],
    debug_dir: str | None = None,
) -> tuple[dict | None, str]:
    """Build one variant. Returns (variant_or_None, human-readable reason).

    The reason string is not decoration — it is what the user is told when the
    batch produces nothing, and it is the only signal that separates "your resume
    is already strong" from "our compiler produced an unreadable PDF".
    """
    rewritten = _rewrite_struct(base_struct, instruction, master_skills, stems)
    if not rewritten:
        print(f"[optimize] {label}: rewrite produced nothing")
        return None, f"{label}: the rewrite step returned nothing (model unavailable)"
    # _rewrite_struct already sanitized and ground-checked every candidate and
    # returned the richest SURVIVING one. Sanitizing the model's JSON matters
    # because a "bullets" that arrived as a plain string is otherwise iterated
    # character by character, emitting one \item per letter: the section's content
    # vanishes, the PDF still compiles, clears the length check, gets scored and
    # stored, and is offered behind a button that overwrites the master resume.
    struct = rewritten.get("resume")
    if not isinstance(struct, dict):
        print(f"[optimize] {label}: rewrite came back malformed")
        return None, f"{label}: the rewrite came back in a shape we couldn't use"
    dropped = rewritten.get("dropped") or []
    # This one IS rendered, so an empty body has to stop here. Letting it through
    # produces a near-blank PDF that still compiles and only fails later at the
    # readability check, where the user is told it is "a bug on our side".
    if not any(s["items"] for s in struct["sections"]):
        if dropped:
            print(f"[optimize] {label}: every item was invented — {dropped[:3]}")
            return None, f"{label}: dropped — the rewrite replaced your real experience with invented content"
        print(f"[optimize] {label}: rewrite returned no content")
        return None, f"{label}: the rewrite came back empty"

    # Identity is ours, not the model's. Redaction means it never saw the real
    # values (module docstring); without this the header ships placeholders.
    _stamp_identity(struct, identity)

    # Drift: a rewrite may reword every real entry, never replace them. Grounding
    # removes invented items one by one, so a wholesale hallucination arrives here
    # as a struct that kept almost nothing of the master's factual content.
    base_items = _factual_item_count(base_struct)
    kept_items = _factual_item_count(struct)
    if base_items >= 2 and kept_items * 2 < base_items:
        print(f"[optimize] {label}: drift — kept {kept_items}/{base_items} real items; dropped {dropped[:3]}")
        return None, (f"{label}: dropped — the rewrite drifted from your resume "
                      f"(kept {kept_items} of your {base_items} real entries)")
    if dropped:
        print(f"[optimize] {label}: removed {len(dropped)} ungrounded item(s): {dropped[:3]}")

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

    if score < baseline_score - _SCORE_NOISE:
        # Never offered. A materially lower-scoring rebuild next to the user's own
        # resume is not information — it's a worse document wearing the same "Use
        # as my resume" button. The audit trail keeps it; the card doesn't.
        print(f"[optimize] {label}: discarded ({score} < baseline {baseline_score})")
        return None, f"{label}: scored {score} vs your {baseline_score} — discarded, it came out worse"

    if beats:
        print(f"[optimize] {label}: kept ({score} > {baseline_score})")
        reason = f"{label}: {score} vs your {baseline_score} — kept"
    else:
        print(f"[optimize] {label}: kept as a tie ({score} vs baseline {baseline_score})")
        reason = (f"{label}: {score} against your {baseline_score} — level within the scorer's "
                  f"margin, kept for its cleaner layout")
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


def _item_count(struct: dict | None) -> int:
    if not struct:
        return 0
    return sum(len(sec.get("items") or []) for sec in struct.get("sections") or [])


def _extract_struct(text: str) -> dict | None:
    """The master resume as structured JSON — the input every rewrite works from.

    An empty result here is the single most dangerous outcome in this module, and
    it is the one that shipped. chat_json_ensemble merges the N responses by
    majority vote on each list item's exact content (llm._merge_lists). That was
    assumed safe for extraction because models are told to copy facts verbatim —
    but they don't agree byte-for-byte on section names, ordering, or where a
    date lives, so the merge kept nothing. Measured on a real 3,778-character
    resume: response 0 held 12 items, response 1 held 15, the merge returned 0.

    Downstream, an empty resume JSON does not fail loudly — it is handed to a
    model with "rewrite this resume", and the model obliges by inventing one.
    That is exactly how a user's dashboard came to offer a resume whose employers
    were "XYZ Corp" and "ABC Tech". So: keep the merge (cross-model agreement is
    genuinely higher fidelity when it survives), but never accept its result on
    faith — fall back to the richest single response the way the rewrite path
    already does.
    """
    prompt = (
        f'Resume text:\n"""\n{text[:6000]}\n"""\n\n'
        "Return the structured JSON object described in your instructions."
    )
    # One round of provider calls, merged locally. chat_json_ensemble would do the
    # same calls and then throw the responses away, leaving a failed merge with
    # nothing to fall back on but a second full round — and the merge fails on
    # every real resume tried so far, so that second round was the normal path:
    # six provider calls and twice the latency for the same three answers.
    dicts = [
        parsed for parsed in (llm_mod._extract_json(raw)
                              for raw in llm_mod.chat_ensemble(prompt, system=_EXTRACT_SYS, n=3, timeout=90)
                              if raw)
        if isinstance(parsed, dict)
    ]
    if not dicts:
        return None

    merged = llm_mod._merge_json(dicts) if len(dicts) > 1 else dicts[0]
    best = _sanitize_struct(merged)
    best_count = _item_count(best)
    if best_count >= _MIN_BASE_ITEMS:
        return best

    print(f"[optimize] merged extraction kept {best_count} item(s) — using the richest single response")
    for parsed in dicts:
        cand = _sanitize_struct(parsed)
        if _item_count(cand) > best_count:
            best, best_count = cand, _item_count(cand)
    return best


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
    "4. Keep it to one page of content — be concise, but never drop a role, "
    "project, qualification, or concrete detail that is in the input. Losing "
    "content is a worse resume, not a tighter one.\n"
    "5. In a skills section every item is a terse comma-separated list of tools "
    "('Databases: PostgreSQL, MongoDB, Redis'), never a sentence. Prose there "
    "wastes the line a recruiter scans for keywords.\n"
    "No markdown, no prose outside the JSON object."
)


def _rewrite_struct(
    base_struct: dict, instruction: str, master_skills: list[str], stems: set[str]
) -> dict | None:
    skills_line = ", ".join(master_skills) if master_skills else "(none extracted)"
    prompt = (
        f"Strategy: {instruction}\n\n"
        f"The candidate's real, defensible skills (using anything outside this set "
        f"is forbidden): {skills_line}\n\n"
        f"Resume JSON to rewrite:\n{json.dumps(base_struct, ensure_ascii=False)[:6000]}\n\n"
        "Return the {\"resume\": ..., \"changes\": ...} JSON object."
    )
    # NOT chat_json_ensemble. That MERGES the N responses, and the merge votes on
    # each list item by its exact content (llm._merge_lists keeps only items a
    # majority of models produced verbatim). Extraction survives it because every
    # model is told to copy the facts word-for-word, so the section items are
    # identical and agree. A REWRITE is the opposite by construction — each model
    # rewords the bullets its own way — so no rewritten section is ever produced
    # identically by two models, the merge discards ALL of them, and `sections`
    # comes back []. Every strategy then failed with "rewrite returned no content"
    # and the whole feature produced nothing. (Proven: three reworded responses
    # merge to sections=[].)
    #
    # Take whole, un-merged responses instead and keep the RICHEST coherent one.
    # The cross-model diversity this feature wants comes from the three distinct
    # STRATEGIES, each compiled and re-scored downstream — not from blending three
    # rewrites of one strategy into their (empty) intersection.
    #
    # Richest, not merely first-non-empty: a model sometimes returns a section
    # heading with its items dropped (seen live — a rewrite kept the six skill
    # bullets but emptied Experience/Projects/Education, so the compiled PDF held
    # ~196 characters and was rejected). The first-non-empty response passed the
    # "any items" check on its skills alone, and a fuller sibling response was
    # thrown away. Score each by how much content survived and keep the best.
    #
    # Richest AFTER GROUNDING, though — weighing the raw response made this
    # function reward fabrication. A model that ignores the input and emits a
    # generic template resume ("AI Engineer, XYZ Corp"; "MSc, University of
    # Technology") produces MORE items and bullets than a faithful sibling that
    # merely rewords the candidate's four real projects, so the invented one won
    # every time. That reached a user's dashboard as an 82-scoring resume
    # containing not one true employer, school, or date. Grounding first, then
    # weigh what's left: a hallucinated response weighs ~0 and can't win.
    fallback = None
    best, best_weight = None, -1
    for raw in llm_mod.chat_ensemble(prompt, system=_REWRITE_SYS, n=3, timeout=120):
        parsed = llm_mod._extract_json(raw)
        if not isinstance(parsed, dict):
            continue
        raw_struct = parsed.get("resume") if isinstance(parsed.get("resume"), dict) else parsed
        if not isinstance(raw_struct, dict):
            continue
        sanitized = _sanitize_struct(raw_struct)
        if not sanitized:
            continue
        grounded, dropped = _ground_struct(sanitized, stems, base_struct)
        changes = _clean_changes(parsed.get("changes"))
        # Keep one shaped-but-empty response so _one_variant can report an
        # accurate "empty/invented" reason rather than "model unavailable".
        fallback = fallback or {"resume": grounded, "changes": changes, "dropped": dropped}
        if not any(sec["items"] for sec in grounded["sections"]):
            continue
        weight = sum(
            1 + len(item["bullets"])
            for sec in grounded["sections"] for item in sec["items"]
        )
        if weight > best_weight:
            best = {"resume": grounded, "changes": changes, "dropped": dropped}
            best_weight = weight
    return best or fallback


# ---------------- truthfulness gate ----------------

def _allowed_tokens(source_text: str, master_skills: list[str]) -> set[str]:
    """Every alnum-ish token the candidate can defend: it appears in their resume
    text, or it's in their extracted master skill set. A variant may use only
    these as skill/tool vocabulary.

    Dotted names are also registered by their parts. The token pattern includes
    ".", so "Node.js" produced the single token "node.js" and never "node" —
    then _fabricated_skills, whose KNOWN_SKILLS vocabulary lists plain "node",
    could not defend it and rejected the rewrite for "inventing" a skill printed
    on the candidate's own resume. Observed live: all three variants dropped on
    ['node'], so the optimizer produced nothing at all. The same held for
    ".NET", "Vue.js" and anything else punctuated.
    """
    def _add(target: set[str], text: str) -> None:
        for tok in re.findall(r"[a-z0-9+#.]+", text):
            tok = tok.strip(".")
            if not tok:
                continue
            target.add(tok)
            if "." in tok:
                # "node.js" also defends "node" and "js".
                target.update(p for p in tok.split(".") if len(p) >= 2)

    allowed: set[str] = set()
    _add(allowed, (source_text or "").lower())
    for s in master_skills or []:
        _add(allowed, s.lower())
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


# ---------------- identity (never from the model) ----------------

_CID_RE = re.compile(r"\(cid:\d+\)")
_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
_PHONE_RE = re.compile(r"(?:\+\d{1,3}[\s-]?)?\d{5}[\s-]?\d{5}\b|(?:\+\d{1,3}[\s-]?)?\d{10}\b")
_GLYPH_RE = re.compile(r"[^\w@.+\-/:,&() ]")
_PLACEHOLDER_RE = re.compile(r"\[[^\]]*redact[^\]]*\]", re.I)
# A document title is not a name. Plenty of templates open with "Curriculum Vitae"
# or "RESUME" on its own line, which passes every other test for a person's name.
_NOT_A_NAME = frozenset({"resume", "curriculum", "vitae", "cv", "profile", "summary", "biodata"})


def _identity_from_source(text: str, contact_fallback: str = "") -> tuple[str, str]:
    """(name, contact_line) read from the RAW resume, before any redaction.

    Everything the model returns for these two fields is placeholder text — the
    LLM boundary redacts PII on the way out, so "[email redacted]" is a faithful
    copy of what it was shown. Taking the header off the source locally is the
    only way the compiled PDF carries a real phone number.
    """
    lines = [ln.strip() for ln in (text or "").splitlines()]
    lines = [ln for ln in lines if ln][:8]

    name = ""
    for ln in lines[:3]:
        cand = _CID_RE.sub("", ln).strip()
        words = cand.split()
        if not (1 < len(words) <= 5) or "@" in cand or any(c.isdigit() for c in cand):
            continue
        if any(w.lower().strip(".,:") in _NOT_A_NAME for w in words):
            continue
        # Capitalisation is what separates a name from the first line of a summary
        # ("experienced developer with 5 years…"). One lowercase particle is fine
        # ("van der Berg"); a whole lowercase sentence is not a name.
        lowercase = sum(1 for w in words if not w[:1].isupper())
        if lowercase <= 1:
            name = cand
            break

    contact = ""
    for ln in lines[:6]:
        if _EMAIL_RE.search(ln) or _PHONE_RE.search(ln):
            contact = _header_line(ln)
            if contact:
                break
    if not contact:
        # No single header line carried it (two-column templates split the header
        # across lines). Rebuild from whatever the top of the document holds.
        head = "\n".join(lines)
        bits: list[str] = []
        m = _PHONE_RE.search(head)
        if m:
            bits.append(m.group(0).strip())
        m = _EMAIL_RE.search(head)
        if m:
            bits.append(m.group(0).strip())
        contact = " | ".join(bits)
    return name, (contact or _clean_contact_line(contact_fallback))


def _header_line(line: str) -> str:
    """The line as a contact header, or "" if it only happens to contain an email.

    Containing an address was not enough of a test. A resume whose header carries
    no contact details puts them further down in prose — "Email sneha@x.com at the
    very bottom" — and taking that line whole printed the sentence across the top
    of the rebuilt resume. A header is a short, separator-delimited list, so:
    drop segments that are neither contact details nor short labels (a city, a
    GitHub handle), and reject a lone prose segment outright so the caller falls
    back to pulling the address and phone number out on their own.
    """
    cleaned = _clean_contact_line(line)
    if not cleaned:
        return ""
    segments = [s.strip() for s in cleaned.split("|") if s.strip()]

    def _is_contact(seg: str) -> bool:
        return bool(_EMAIL_RE.search(seg) or _PHONE_RE.search(seg)
                    or re.search(r"(?:https?://|www\.|\w+\.(?:com|io|dev|org|net|in)\b)", seg, re.I))

    if len(segments) == 1:
        seg = segments[0]
        return seg if _is_contact(seg) and len(seg.split()) <= 4 else ""
    kept = [s for s in segments if _is_contact(s) or len(s.split()) <= 3]
    return " | ".join(kept)


def _clean_contact_line(line: str) -> str:
    """Strip the icon-font debris a PDF text layer leaves in a header line.

    Extracted headers arrive as "(cid:132) +91 90000 00000 | # me@x.com | § handle"
    — the glyphs are FontAwesome icons with no Unicode mapping. Printing them back
    into a new PDF renders mojibake next to the phone number.
    """
    out = []
    for seg in _CID_RE.sub("", line or "").split("|"):
        seg = _GLYPH_RE.sub(" ", seg)
        seg = re.sub(r"\s+", " ", seg).strip(" .,-")
        if seg:
            out.append(seg)
    return " | ".join(out)


def _stamp_identity(struct: dict, identity: tuple[str, str]) -> None:
    """Force the real name/contact onto a struct, in place. A model-supplied value
    is used only where we found nothing locally — and even then, never a redaction
    marker: a header reading "[email redacted]" is worse than no header at all, and
    it is the model's most likely answer since that is what it was shown."""
    name, contact = identity
    if name:
        struct["name"] = name
    if contact:
        struct["contact_line"] = contact
        return
    scrubbed = _PLACEHOLDER_RE.sub("", str(struct.get("contact_line") or ""))
    struct["contact_line"] = _clean_contact_line(scrubbed)


# ---------------- grounding + provenance ----------------

_NUM_TOKEN_RE = re.compile(r"(?<![A-Za-z0-9])\d[\w,.+/%-]*")


def _number_aliases(raw: str) -> set[str]:
    """Every form the same quantity legitimately takes on a resume.

    "50k+" and "50,000+" are one fact written two ways, and a rewrite is allowed
    to reformat it. Without this, three real entries were deleted as invented in a
    live run: "50k+ tokens" was read as a bare "50", "3D/VR" as a bare "3", and
    "1st place" as a bare "1" — none of which appear in the resume as standalone
    numbers, so all three "failed" grounding.
    """
    t = (raw or "").lower().strip(".,+/-%")
    if not t:
        return set()
    aliases = {t}
    digits = re.sub(r"[^\d.]", "", t).strip(".")
    if digits:
        aliases.add(digits)
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([km])", t)
    if m:
        try:
            aliases.add(str(int(float(m.group(1)) * (1000 if m.group(2) == "k" else 1_000_000))))
        except ValueError:
            pass
    return aliases


def _number_grounded(raw: str, stems: set[str]) -> bool:
    return bool(_number_aliases(raw) & stems)


def _source_stems(source_text: str) -> set[str]:
    """Every token of the master resume, plus 5-char stems so ordinary
    morphology ("Engineered" -> "engineer") doesn't read as invented, plus every
    alias of every number it states."""
    stems: set[str] = set()
    for raw in _NUM_TOKEN_RE.findall((source_text or "").lower()):
        stems |= _number_aliases(raw)
    for tok in re.findall(r"[a-z0-9][a-z0-9+#./-]*", (source_text or "").lower()):
        tok = tok.strip("./-")
        if not tok:
            continue
        stems.add(tok)
        if len(tok) >= 5:
            stems.add(tok[:5])
        for part in re.split(r"[./-]", tok):
            if len(part) >= 2:
                stems.add(part)
                if len(part) >= 5:
                    stems.add(part[:5])
    return stems


def _is_grounded(tok: str, stems: set[str]) -> bool:
    """A token is grounded if the master resume can defend it.

    Digits are exact-match: a year or a metric is a claim, and "2020" is not
    supported by "2021". Words match on stem, so rewording stays free.
    """
    t = tok.strip("./-").lower()
    if not t:
        return True
    if t.isdigit():
        return t in stems
    if t in _FREE_WORDS or len(t) < 4:
        return True
    return t in stems or (len(t) >= 5 and t[:5] in stems)


def _ungrounded_tokens(item: dict, stems: set[str], check_title: bool = True) -> list[str]:
    """Words in an item's title/meta — and NUMBERS anywhere in it — that the master
    resume cannot defend. This is what catches "XYZ Corp", "University of
    Technology | 2020" and "Achieved 30 FPS": the skills gate never looked at
    employers, schools, dates, or metrics, only at tools.

    `check_title=False` for a skills group, whose head is a CATEGORY the rewrite
    invented for grouping ("Frontend", "Backend", "AI/ML & Vision") and not a claim
    about the candidate. Checking those cost a live run all three variants: eight
    grouping labels were deleted as "not in your resume", the documents came out
    nearly empty, and they scored 20-35 against an 88 master.
    """
    bad: list[str] = []
    if check_title:
        for field in ("head", "sub"):
            value = str(item.get(field) or "")
            for raw in re.findall(r"[A-Za-z0-9][A-Za-z0-9+#./-]*", value):
                # "AI/ML" is two tokens. _source_stems splits on the separators, so
                # a checker that doesn't would flag a word the resume plainly has.
                for tok in re.split(r"[/]", raw):
                    if not tok:
                        continue
                    ok = _number_grounded(tok, stems) if tok[0].isdigit() else _is_grounded(tok, stems)
                    if not ok and tok.lower() not in {b.lower() for b in bad}:
                        bad.append(tok)
    for b in item.get("bullets") or []:
        # Numbers that START a token only. A digit glued behind a word is part of a
        # tool name — "YOLOv8" is not a claim that something happened eight times,
        # but it was read as a bare "8" and rejected as an invented metric.
        for raw in _NUM_TOKEN_RE.findall(str(b)):
            if not _number_grounded(raw, stems) and raw not in bad:
                bad.append(raw)
    return bad


def _content_tokens(item: dict) -> set[str]:
    """Distinctive words of an item — what provenance matching compares."""
    blob = " ".join([
        str(item.get("head") or ""), str(item.get("sub") or ""),
        " ".join(str(b) for b in (item.get("bullets") or [])),
    ]).lower()
    return {
        t for t in re.findall(r"[a-z0-9][a-z0-9+#./-]*", blob)
        if len(t) >= 4 and t not in _FREE_WORDS
    }


def _base_item_tokens(base_struct: dict) -> list[set[str]]:
    return [
        _content_tokens(item)
        for sec in base_struct.get("sections") or []
        for item in sec.get("items") or []
    ]


def _has_ancestor(item: dict, base_index: list[set[str]]) -> bool:
    """True if this item is a rewrite of something the master actually contains.

    A rewrite may reword, merge, split, and drop entries; it may not ADD one. Any
    genuine rewording keeps the proper nouns (employer, project name, tools), so
    three shared distinctive words is a low bar for a real entry and an unreachable
    one for an invented "Scalable Chatbot Backend" that shares nothing with the
    candidate's actual projects.

    Except when the entry has fewer than three distinctive words to give. SPLIT is
    explicitly allowed, and splitting "Certifications: ServiceNow Fundamentals,
    Python Bootcamp, Data Mining" into one item per certificate leaves each with
    two words — real content that a flat threshold of three would delete as
    invented. Short items must instead match ALL of what they have.
    """
    mine = _content_tokens(item)
    if not mine:
        return False
    need = min(3, len(mine))
    return any(len(mine & base) >= need for base in base_index)


def _ground_struct(
    struct: dict, stems: set[str], base_struct: dict
) -> tuple[dict, list[str]]:
    """Remove every item the master resume can't defend. Returns (struct, dropped).

    Repair, not reject: one hallucinated Education entry shouldn't cost the user
    the three real Projects in the same response. Wholesale invention still fails
    — it arrives here as a struct that loses nearly everything, which _one_variant
    catches as drift.
    """
    base_index = _base_item_tokens(base_struct)
    dropped: list[str] = []
    sections: list[dict] = []
    for sec in struct.get("sections") or []:
        heading = sec.get("heading") or ""
        # Skills groupings ("Frontend", "Databases") exist on no master resume, so
        # provenance can't apply; _fabricated_skills covers their content instead.
        skillsy = bool(_SKILLS_SECTION_RE.search(heading))
        kept: list[dict] = []
        for item in sec.get("items") or []:
            label = str(item.get("head") or item.get("sub") or "item")[:60]
            bad = _ungrounded_tokens(item, stems, check_title=not skillsy)
            if bad:
                dropped.append(f"{heading}/{label}: not in your resume ({', '.join(bad[:3])})")
                continue
            if not skillsy and base_index and not _has_ancestor(item, base_index):
                dropped.append(f"{heading}/{label}: no matching entry on your resume")
                continue
            kept.append(item)
        if kept:
            sections.append({"heading": heading, "items": kept})
    return (
        {"name": struct.get("name") or "", "contact_line": struct.get("contact_line") or "",
         "sections": sections},
        dropped,
    )


def _factual_item_count(struct: dict) -> int:
    """Items that assert a fact about the candidate's history — skills groupings
    excluded, since a rewrite is free to regroup those."""
    return sum(
        len(sec.get("items") or [])
        for sec in struct.get("sections") or []
        if not _SKILLS_SECTION_RE.search(sec.get("heading") or "")
    )


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
        raw_heading = str(sec.get("heading") or "").strip()
        heading = _esc(raw_heading)
        if not heading:
            continue
        # Heading + full-width rule. \hrulefill is horizontal-mode safe (unlike a
        # bare \hrule, which needs vertical mode); \par ends each line cleanly so a
        # rewrite can never leave the compiler mid-paragraph.
        lines.append("\\vspace{8pt}\\noindent{\\large \\textbf{" + heading + "}}\\par")
        lines.append("\\vspace{1pt}\\noindent\\hrulefill\\par")
        lines.append("\\vspace{3pt}")
        items = (sec.get("items") or [])[:_MAX_ITEMS]
        # Decided once for the whole section, not per item: a rewrite that returns
        # one terse group and one wordy one would otherwise render half the section
        # as lines and half as bullets. Long entries mean the model wrote prose
        # where it was asked for a keyword list — bullets stay readable there,
        # a paragraph of joined sentences does not.
        inline_skills = bool(_SKILLS_SECTION_RE.search(raw_heading)) and all(
            len(str(b)) <= 120 for it in items for b in (it.get("bullets") or [])
        )
        for item in items:
            head = _esc(item.get("head") or "")
            sub = _esc(item.get("sub") or "")
            # A skills group is a LIST OF WORDS, not a list of achievements. Given
            # one \item per word it renders as a column of single terms — seven
            # groups became thirty bullets and pushed a one-page intern resume onto
            # two, which is exactly the "column of nouns" a user looked at and
            # called unusable. Recruiters and parsers both read "Frontend: Next.js,
            # React" fine, and it costs six lines instead of thirty.
            short = [b for b in (item.get("bullets") or []) if str(b).strip()][:_MAX_BULLETS]
            if inline_skills and short:
                # Every group inline, not just the ones whose entries are single
                # words: a section that renders "Programming & Frameworks: Python,
                # TypeScript" as a line and "AI/ML & Vision" as a bulleted column
                # right under it looks broken, and that mixture is what shipped.
                sep = "; " if any("," in str(b) for b in short) else ", "
                joined = sep.join(_esc(str(b).strip()[:_MAX_BULLET_CHARS]) for b in short)
                if head:
                    lines.append("\\noindent\\textbf{" + head + ":} " + joined + "\\par")
                else:
                    lines.append("\\noindent " + joined + "\\par")
                lines.append("\\vspace{2pt}")
                continue
            if head or sub:
                if head and sub:
                    # One left-to-right run, NOT \hfill. Right-aligning the meta
                    # looks tidy to a human and breaks the reading order a parser
                    # sees: the two runs sit at different x-positions, so the text
                    # layer can emit them out of order. Observed on a rebuilt
                    # resume — "B.Sc in Computer Science, 2026 (CGPA 8.1)" was
                    # extracted BEFORE the "EDUCATION" heading it belongs under.
                    # Being read correctly by a machine is the entire point of this
                    # document, so the dates lose their right margin.
                    lines.append("\\noindent\\textbf{" + head + "} \\textemdash{} " + sub + "\\par")
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

    # Deliberately NOT rejecting a struct whose sections came back empty here.
    # This function is shared: _extract_struct feeds the result into the rewrite
    # prompt rather than rendering it, so a skeletal extraction is still useful
    # input — and rejecting it aborted the whole optimize run with
    # "structured extraction failed" on nothing worse than ensemble variance.
    # The near-blank-render guard lives in _variant, on the path that actually
    # compiles a PDF.
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
