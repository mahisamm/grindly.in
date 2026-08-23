"""ATS-optimized resume variants — the "3 better resumes" feature.

Pipeline (all invisible to the user; they see scores + a plain-English change list):

    1. Extract the master resume text into a generic, template-agnostic structure
       (name, contact, sections -> items -> bullets) via one LLM call.
    2. Rewrite that structure three ways, each under a different ATS strategy. The
       rewrites may reword, reorder, tighten, and surface real keywords. Three
       gates run before a variant is ever rendered —
         * skills:     no tool/technology absent from the source (_fabricated_skills)
         * grounding:  no company, school, date, metric or named product whose
                       words aren't in the source (_title_ungrounded,
                       ungrounded_in_bullet)
         * provenance: every non-skills item must descend from a real item on the
                       master (a rewrite may reword an entry, never add one)

       WHAT THESE DO AND DO NOT GUARANTEE. They catch: any technology in the
       vocabulary (TECH_VOCAB, ~450 names) in any case; any capitalised proper
       noun mid-sentence; any acronym; any number in any unit; any employer,
       school or date; and any whole entry with no ancestor on the master.
       They do NOT catch a lower-case product name that is absent from the
       vocabulary and reads as an ordinary English word. That is a real hole and
       it is stated here rather than papered over: this module used to claim
       invention was "impossible" while an adversarial run walked nine
       fabrications out of twenty-six straight through it.

       The gates are also tuned against FALSE positives, which matter as much.
       A gate that rejects an honest rewrite produces nothing and blames the
       user's resume for it — measured at 56% of truthful rewrites before
       `_morph_variants` and `_EQUIVALENTS` existed, because "RESTful" did not
       match "REST" and "API" did not match "APIs". `tests/test_gates.py`
       measures both directions and is the file to read before touching any of
       this.
    3. Render each surviving structure into a fixed, single-column HTML template
       (parser-friendly by construction — no columns, tables, or graphics for a
       parser to mangle) with every field escaped, then print it to PDF with
       headless Chromium. See `render_pdf`.
    4. Re-extract the text a recruiter's ATS would actually see out of that PDF
       and score it with `readiness.score` — the SAME deterministic function the
       master was scored with. Keep ONLY variants that scored at least as high
       as the master: the "better resume" claim is measured, never asserted.

Step 4 is the whole product. The score is a pure function of the extracted
bytes, so "this rewrite is 11 points better" is reproducible on any machine, and
a variant that does not actually beat the master cannot be shown as though it
did. The previous build scored with an LLM ensemble that returned 70, 76 and 88
for one unchanged document; every comparison it made was noise dressed as a
measurement.

Identity (name + contact line) is NEVER taken from the model. Outbound prompts
are PII-redacted at the LLM boundary (agent/redact.py), so the model literally
sees "[phone redacted] | [email redacted]" and — doing exactly as told — copies
those placeholders back. That shipped: a compiled variant whose header carried no
phone and no email, i.e. a resume no employer could reply to. Identity is now
lifted from the raw source text locally and stamped onto every variant after the
rewrite.

Why a clean rebuild and not a clone of the user's PDF: an LLM cannot faithfully
reconstruct a multi-column college template's geometry and fonts from extracted
text, and those very templates are exactly what parsers choke on. Rebuilding
onto a clean single-column template is both the honest option and the one that
actually raises the score.

Targeting (a company pack, or a pasted job description) rides on the same
pipeline: `emphasis` lines are appended to each strategy's instruction and
`target_keywords` are handed to the scorer so the coverage band is live. The
three gates are untouched and unaware, which is the guarantee — targeting can
change what a rewrite surfaces and can never buy it a fabricated fact.
"""
from __future__ import annotations

import json
import os
import re
import tempfile

import llm as llm_mod
import readiness
import render_pdf
import resume_parse

# Keep the whole feature bounded — an intern resume is one page. These caps stop a
# runaway LLM response from producing a 6-page document or a pathological compile.
_MAX_SECTIONS = 7
_MAX_ITEMS = 8
_MAX_BULLETS = 6
_MAX_BULLET_CHARS = 240
# A role/project title or its meta line. Long enough for "Software Engineering
# Intern — Payments Platform"; short enough that a model returning a paragraph
# in the title field cannot blow out the header of every item on the page.
_MAX_HEAD_CHARS = 160
_MAX_PAGES = render_pdf.MAX_PAGES  # a variant that spills past this isn't a win, it's a mess
# Below this, the extraction didn't understand the resume. Rewriting from it is
# not "a thin variant" — it is a model being handed an empty document and asked to
# improve it, which it does by inventing a career. See _extract_struct.
_MIN_BASE_ITEMS = 3
# How far below the master a variant may land and still be shown, labelled as
# level rather than better.
#
# This used to be 6, and the comment here used to explain why: the scorer was
# resume_ai.analyze(), an LLM ensemble that returned 70, 76 and 88 for the SAME
# document on three consecutive runs. A ±9 ruler cannot resolve a 6-point
# improvement, so the tolerance existed purely to stop noise from throwing away
# good rewrites — and it also meant a variant genuinely 5 points worse than the
# master was shown as "level".
#
# readiness.score() is a pure function: identical bytes give an identical number,
# every time, on every machine. There is no noise left to absorb, so a variant
# that scores below the master is worse, full stop, and is dropped. 0 is not a
# tightened threshold; it is the threshold the old one was approximating around
# a measurement error we no longer have.
_SCORE_NOISE = 0

# How much of the resume the model is SHOWN. These used to be 6,000 characters
# for both the text and the JSON — and the JSON of an extracted resume runs
# ~1.4x its text, so any resume past ~4,400 characters (most one-pagers, every
# two-pager) had its rewrite input cut MID-JSON. The model was handed a broken
# object with the later sections missing and, naturally, returned a resume
# without them: the content-loss gate then rejected its own input's absence
# as "tightening went too far". Found while chasing a targeted run that
# produced nothing. 24k/40k characters is ~6k/10k tokens — inside every
# current model's context with room for the instructions — and no real
# resume approaches it; the cap bounds a pathological paste, never a normal one.
_PROMPT_TEXT_CHARS = 24000
_PROMPT_JSON_CHARS = 40000

# The one-page budget, when the user has chosen it (Resume.targetPages = 1).
# Appended to every strategy so the model writes to the page from the first
# draft; a second, firmer pass runs only if the first render spills.
# Layout densities for the page-fitting ladder (see render_pdf.render_fitted).
# Density scales leading and gaps, never letter-spacing (the measured parse
# cliff) and never content — extracted text is identical at every rung.
# 0.85 reads as "efficient"; 0.78 is the floor before cramped.
_COMPACT_DENSITY = 0.85
_DENSE_DENSITY = 0.78

_PAGE_BUDGET_SUFFIX = (
    "\n\nHARD LENGTH CONSTRAINT: the finished resume must fit on ONE printed page. "
    "Keep EVERY section, role, project, degree, certification, date, number and "
    "skill — nothing may be removed. Get there by tightening: one line per bullet "
    "where possible, merge bullets that say the same thing, cut filler words and "
    "repeated tool names, shorten a summary to two lines. Fewer words, not fewer facts."
)
_TIGHTEN_INSTRUCTION = (
    "Your previous rewrite rendered at {pages} pages; the hard limit is {budget} page. "
    "Return the SAME resume — every section, role, project, degree, date, number and "
    "skill present and in the same order — but shorter: every bullet on one line "
    "(under 110 characters), merge bullets that overlap, drop filler words and repeated "
    "stack mentions, cut the summary to one line or remove it (its facts live in the "
    "entries). Do not remove any entry. Return the usual {{\"resume\": ..., "
    "\"changes\": ...}} JSON."
)

# Filled by _rewrite_struct, read by _one_variant — see the note at the loop.
_REWRITE_DIAG: dict[str, int] = {"answers": 0, "parsed": 0}

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
        "the source does not state — a fabricated number is a failed interview.\n"
        "This applies to outcomes WITHOUT numbers too, and that is the rule most "
        "often broken. Do not append consequences the source does not claim: no "
        "'ensuring a seamless transition', no 'providing actionable insights', no "
        "'enhancing decision-making', no 'improving efficiency'. Those read as "
        "impact and are unverifiable padding — the candidate has to defend every "
        "word of this document in an interview. If the source states no outcome "
        "for a bullet, the rewrite states no outcome for it either: put the verb "
        "first, name the tool, and stop.",
    ),
    (
        "ATS-clean",
        "Tighten and de-clutter: remove filler words, fix inconsistent tense, use "
        "plain standard section headings, and make each bullet a single scannable "
        "line. Preserve every fact; change only wording and structure.\n"
        "HARD LIMITS ON WHAT 'TIGHTEN' MEANS. Keep every section the input has, "
        "including a summary or profile. Keep every role, project, qualification "
        "and bullet — the output must have the same number of bullets as the "
        "input, or more. Tightening is fewer words inside a bullet, never fewer "
        "bullets. Keep every tool name, every number and every date; those are "
        "the words a recruiter searches for and the shortest bullet on the page "
        "is worth nothing if it no longer says what you built. Aim to remove at "
        "most a fifth of the words.",
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



def _progress(message: str) -> None:
    """Report what the pipeline is doing, for a human who is waiting.

    A batch is minutes long, and until now the only thing the person who pressed
    the button saw was a spinner and a sentence guessing at the duration. These
    lines go to stdout, which cli.py has already pointed at stderr for the whole
    run, so they cannot corrupt the single JSON object on the real stdout — and
    lib/agent.ts reads them off the stderr pipe as they arrive.

    Written in the user's terms, not the pipeline's: "Writing the keyword-first
    rebuild", never "[optimize] variant 2/3". The prefix is the only machine-read
    part.
    """
    print(f"[progress] {message}")


def _targeted_strategies(
    strategies: list[tuple[str, str]],
    emphasis: list[str] | None,
    target_name: str = "",
) -> list[tuple[str, str]]:
    """Fold a company pack's emphasis into every strategy's instruction.

    Targeting changes what a rewrite SURFACES, never what it may claim. The
    emphasis lines come from `companies.py`, where each one is backed by
    something the employer published, and they are appended after the strategy
    so the strategy still sets the shape of the rewrite. The three gates
    downstream (skills, grounding, provenance) are unchanged and unaware that
    targeting happened — which is the point: a company pack cannot buy a
    fabricated bullet past them.
    """
    if not emphasis:
        return strategies
    block = "\n".join(f"- {line}" for line in emphasis)
    suffix = (
        f"\n\nThis resume is being tailored for a role at {target_name}. "
        f"Apply the following emphasis, which comes from what {target_name} has "
        f"published about how it hires:\n{block}\n"
        "Emphasis means reorder, reword and surface what the source already "
        "contains. It is NEVER permission to add a skill, employer, date, "
        "metric or achievement the source does not state. If the candidate "
        "lacks something this role wants, leave it out — a gap is reported to "
        "them separately and honestly."
    ) if target_name else (
        f"\n\nApply the following emphasis when choosing what to surface:\n{block}\n"
        "Emphasis means reorder, reword and surface what the source already "
        "contains — never add a fact it does not state."
    )
    return [(label, instruction + suffix) for label, instruction in strategies]


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
    target_keywords: list[str] | None = None,
    emphasis: list[str] | None = None,
    target_name: str = "",
    source_links: list[str] | None = None,
    link_style: str = "url",
    max_pages: int | None = None,
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

    EXCEPT on a targeted run. There the user's request is not "beat my number",
    it is "give me the {company}-shaped version of my resume" — and a master
    that already scores 95 would otherwise make every tailored rebuild
    undeliverable, turning the whole Target feature off for exactly the users
    who polished their resume most. So when a target is set and nothing won or
    tied, the single best rebuild ships anyway, flagged materially_worse and
    labelled with both numbers, so the user gets the company-shaped document
    AND the honest comparison instead of an empty result. Winners and ties
    still take precedence; losers still never ship beside a win.

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
    target_keywords = [k for k in (target_keywords or []) if k and k.strip()]
    if len(text) < 200:
        print("[optimize] source too short to rebuild safely")
        return {"variants": [], "baseline": 0, "reasons": [], "aborted": "source_too_short"}
    if not render_pdf.renderer_available():
        print("[optimize] chromium/playwright unavailable — cannot render variants")
        return {"variants": [], "baseline": 0, "reasons": [], "aborted": "no_renderer"}

    # The master's score, measured on exactly the same ruler every variant will be
    # measured on. This used to re-run an LLM ensemble "so the comparison is
    # apples-to-apples rather than against a stored score produced by a different
    # provider mix on a different day" — a real problem that only existed because
    # the scorer was a model. readiness.score() has no provider mix and no day.
    baseline_report = readiness.score(text, target_keywords)
    baseline_score = int(baseline_report.get("score") or 0)
    print(f"[optimize] baseline = {baseline_score} ({baseline_report.get('grade')})")
    _progress("Measured your resume — reading its structure")

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
    identity = _identity_from_source(text, contact_fallback, source_links)
    # How much of the master survived extraction bounds everything downstream: a
    # thin base can only produce thin, low-scoring variants, and from the outside
    # that is indistinguishable from a bad rewrite.
    print(f"[optimize] extracted {len(base_struct['sections'])} section(s), "
          f"{sum(len(s['items']) for s in base_struct['sections'])} item(s)")
    # The scorer already counted the SOURCE's bullets from the raw text. If the
    # structured extraction kept materially fewer, every rebuild will be
    # thinner than the original — not because a model compressed it, but
    # because it was never shown the rest. Said out loud in the audit trail,
    # so a thin batch is explained instead of mistaken for a model's choice.
    extraction_note: list[str] = []
    try:
        source_bullets = int(baseline_report["facts"]["structure"]["bullets"])
    except (KeyError, TypeError, ValueError):
        source_bullets = 0
    extracted_bullets = _bullet_count(base_struct)
    if source_bullets >= 6 and extracted_bullets < source_bullets * 0.6:
        msg = (f"Reading your resume kept only {extracted_bullets} of its {source_bullets} "
               f"bullet points — the rebuilds below are measured against what was read")
        print(f"[optimize] {msg}")
        extraction_note.append(msg)

    # How addresses print, carried on the struct every variant is built from.
    # Set once here rather than at each render site: a rebuild that printed its
    # links differently from the resume it came from would be a difference the
    # user did not ask for.
    base_struct["link_style"] = "label" if link_style == "label" else "url"

    allowed = _allowed_tokens(text, master_skills)
    stems = _source_stems(text)

    strategies = _targeted_strategies(
        _strategies_for(text, base_struct), emphasis, target_name,
    )
    # A page budget is a constraint on every strategy, not a strategy of its
    # own: the user asked for the same rewrites, shorter.
    if max_pages:
        strategies = [(label, instr + _PAGE_BUDGET_SUFFIX) for label, instr in strategies]
        print(f"[optimize] page budget: {max_pages}")

    # A targeted run must end with a company-shaped document in hand — see the
    # docstring. Untargeted runs keep the strict rule: worse-than-master is
    # dropped and only the audit trail remembers it.
    targeted = bool(target_keywords or (target_name or "").strip())

    out: list[dict] = []
    reasons: list[str] = list(extraction_note)
    total = len(strategies)
    for index, (label, instruction) in enumerate(strategies, start=1):
        _progress(f"Writing the {label.lower()} rebuild ({index} of {total})")
        variant, reason = _one_variant(
            label, instruction, base_struct, allowed, master_skills, baseline_score,
            identity, stems, debug_dir, target_keywords,
            keep_worse=targeted, target_name=target_name, max_pages=max_pages,
        )
        _progress(f"Rendered and re-measured {index} of {total}")
        reasons.append(reason)
        if variant:
            out.append(variant)

    # Wins first, then ties, then (targeted only) the kept-worse rebuilds.
    out.sort(key=lambda v: (v["beats_baseline"], v["score"]), reverse=True)
    winners = [v for v in out if not v.get("materially_worse")]
    if winners:
        shipped = winners[:3]
    elif out:
        # Targeted, and nothing won or tied: ship ONE best company-shaped
        # rebuild rather than three losing documents wearing identical chrome.
        shipped = out[:1]
    else:
        shipped = []
    _progress("Finishing up")
    return {
        "variants": shipped,
        "baseline": baseline_score,
        "baseline_report": baseline_report,
        "reasons": reasons,
        # The floor, and whether the batch cleared it. Reported per batch as
        # well as per variant so the caller can lead with one honest sentence
        # instead of making the user compare three numbers to a threshold they
        # were never told about.
        "floor": readiness.SHIPPABLE_FLOOR,
        "page_budget": max_pages,
        "meets_floor": bool(shipped) and all(v["meets_floor"] for v in shipped),
        "floor_gap": next((v["floor_gap"] for v in shipped if not v["meets_floor"]), ""),
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
    target_keywords: list[str] | None = None,
    keep_worse: bool = False,
    target_name: str = "",
    max_pages: int | None = None,
) -> tuple[dict | None, str]:
    """Build one variant. Returns (variant_or_None, human-readable reason).

    The reason string is not decoration — it is what the user is told when the
    batch produces nothing, and it is the only signal that separates "your resume
    is already strong" from "our compiler produced an unreadable PDF".
    """
    rewritten = _rewrite_struct(base_struct, instruction, master_skills, stems)
    if not rewritten:
        answers, parsed = _REWRITE_DIAG["answers"], _REWRITE_DIAG["parsed"]
        if answers == 0:
            why = "every model provider failed or was rate-limited — try again in a minute"
        elif parsed == 0:
            why = (f"{answers} model answer{'s' if answers != 1 else ''} came back but none "
                   f"could be read as JSON (cut off or malformed)")
        else:
            why = "the model answers held no usable content"
        print(f"[optimize] {label}: rewrite produced nothing — {why}")
        return None, f"{label}: the rewrite step returned nothing ({why})"
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
    # Compression is not cleanup, and the difference is measurable.
    #
    # "Tighten and de-clutter" is a real strategy and it is also the one that
    # quietly deletes things. Measured on a strong 1,035-character resume: two
    # of three rewrites came back at 790 characters of extracted text, under the
    # thin-resume threshold, having dropped the Professional Summary and pared
    # every bullet past the point where it named a tool. Both scored 85 against
    # the master's 91 and were discarded — correctly, but only after two full
    # renders, and the user was told "nothing beat your resume" when what
    # actually happened is that we threw their summary away.
    #
    # Judged on bullets rather than characters, because bullets are the unit of
    # content: shorter wording is the point of this strategy, fewer facts is
    # not. The gate before rendering saves the render and, more importantly,
    # gives the user a true reason instead of an ambiguous one.
    base_bullets = _bullet_count(base_struct)
    kept_bullets = _bullet_count(struct)
    # Under a one-page budget, MERGING bullets is the instruction, so the bullet
    # count legitimately falls. Entries are still protected by the drift check
    # above; the bullet floor relaxes to half, not to nothing.
    min_keep = 0.5 if max_pages else 0.7
    if base_bullets >= 4 and kept_bullets < base_bullets * min_keep:
        print(f"[optimize] {label}: content loss — {kept_bullets}/{base_bullets} bullets")
        return None, (f"{label}: dropped — tightening went too far and lost "
                      f"{base_bullets - kept_bullets} of your {base_bullets} bullet points")

    if dropped:
        print(f"[optimize] {label}: removed {len(dropped)} ungrounded item(s): {dropped[:3]}")

    changes = _clean_changes(rewritten.get("changes"))
    # Put the gate's work into the change list, which is what gets stored and
    # shown on every later page load. A rewrite that tried to add something and
    # was stopped is the single most reassuring thing this product can tell
    # someone, and until now it only ever appeared in a server log.
    if dropped:
        changes = ([
            f"Removed {len(dropped)} entr{'y' if len(dropped) == 1 else 'ies'} the "
            f"rewrite tried to add that your resume does not support"
        ] + changes)[:5]

    invented = _fabricated_skills(struct, allowed)
    if invented:
        print(f"[optimize] {label}: truthfulness gate rejected invented skill(s): {invented}")
        return None, f"{label}: dropped — it invented skills you don't have ({', '.join(sorted(invented))})"

    html_doc = render_pdf.build_html(struct)

    with tempfile.TemporaryDirectory(prefix="grindly-opt-") as tmp:
        pdf_path = os.path.join(tmp, "variant.pdf")
        built = _render_and_score(struct, pdf_path, target_keywords, fit_pages=max_pages)
        if built.get("error"):
            _dump_debug(debug_dir, label, html_doc,
                        pdf_path if built.get("rendered") else None)
            print(f"[optimize] {label}: {built['error']}")
            return None, f"{label}: {built['error']}"

        # The page budget. The renderer has already walked its density ladder
        # (normal → compact → extra-compact, content identical at every rung).
        # Still over means the WORDS do not fit at any readable density, so one
        # firmer model pass — same facts, fewer words — then the ladder again.
        # Only a resume that spills through all of that ships over budget, and
        # says so: the user chose a page count, not a silent cut.
        over_budget = False
        if max_pages:
            if (built["result"].pages or 0) > max_pages:
                first_pages = built["result"].pages or 0
                print(f"[optimize] {label}: {first_pages} pages against a {max_pages}-page budget — tightening the words")
                # Identity stays out of prompts (module docstring): blanked
                # before the call, stamped back after.
                anon = dict(struct)
                anon["name"] = ""
                anon["contact_line"] = ""
                tighter = _rewrite_struct(
                    anon, _TIGHTEN_INSTRUCTION.format(pages=first_pages, budget=max_pages),
                    master_skills, stems,
                )
                tight_struct = _sanitize_struct(tighter.get("resume")) if tighter else None
                if (
                    tight_struct
                    and any(sec["items"] for sec in tight_struct["sections"])
                    and _factual_item_count(tight_struct) * 2 >= _factual_item_count(base_struct)
                    and not _fabricated_skills(tight_struct, allowed)
                ):
                    _stamp_identity(tight_struct, identity)
                    tight_struct["link_style"] = struct.get("link_style", "url")
                    retry = _render_and_score(tight_struct, pdf_path, target_keywords, fit_pages=max_pages)
                    if not retry.get("error") and (retry["result"].pages or 0) < first_pages:
                        merged = max(0, kept_bullets - _bullet_count(tight_struct))
                        print(f"[optimize] {label}: tightened {first_pages} → {retry['result'].pages} page(s)")
                        struct = tight_struct
                        built = retry
                        if merged:
                            changes = ([
                                f"Merged or shortened {merged} bullet{'s' if merged != 1 else ''} to fit "
                                f"{max_pages} page{'s' if max_pages != 1 else ''} — every role, project and skill kept"
                            ] + changes)[:5]
                    else:
                        print(f"[optimize] {label}: word-tightening did not help — keeping the first")

            over_budget = (built["result"].pages or 0) > max_pages
            if over_budget:
                changes = ([
                    f"Came out at {built['result'].pages} pages against your {max_pages}-page budget even in a "
                    "compact layout — this is more content than one page can hold; trim an older entry to fit"
                ] + changes)[:5]
            elif built["result"].density < 1.0:
                changes = ([
                    f"Set in a compact layout to fit {max_pages} page{'s' if max_pages != 1 else ''} — "
                    "same content, tighter spacing"
                ] + changes)[:5]

        # Below the floor, try the repairs that are ours to make and measure
        # again. One extra render, once, and only for a document that would
        # otherwise be handed over under-strength — see `_repair_for_floor` for
        # what it will and will not touch.
        #
        # The first render's bytes and report are already held in memory, so a
        # retry that fails or does not help costs nothing: `built` simply is not
        # replaced. The struct keeps the repair either way, because a heading a
        # parser can classify is the right heading whether or not it moved the
        # number.
        if built["score"] < readiness.SHIPPABLE_FLOOR:
            repairs = _repair_for_floor(struct, built["report"], master_skills)
            if repairs:
                print(f"[optimize] {label}: {built['score']} is under the floor — repairing: {repairs}")
                retry = _render_and_score(struct, pdf_path, target_keywords, fit_pages=max_pages)
                if retry.get("error"):
                    print(f"[optimize] {label}: repaired render failed ({retry['error']}) — keeping the first")
                elif retry["score"] > built["score"]:
                    print(f"[optimize] {label}: repaired {built['score']} → {retry['score']}")
                    built = retry
                    changes = changes + [f"Fixed for machine readability: {r}" for r in repairs]
                else:
                    print(f"[optimize] {label}: repair did not help ({retry['score']}) — keeping the first")

        result = built["result"]
        parsed = built["parsed"]
        report = built["report"]
        score = built["score"]
        pdf_bytes = built["pdf_bytes"]
        beats = score > baseline_score

        # How much of what we printed survived the round trip. This is the
        # number the product leads with, and it is only meaningful measured
        # here — between the struct we rendered and the text we read back.
        fidelity = readiness.parse_fidelity(_fact_strings(struct), parsed)

    materially_worse = score < baseline_score - _SCORE_NOISE
    if materially_worse and not keep_worse:
        # Never offered. A materially lower-scoring rebuild next to the user's own
        # resume is not information — it's a worse document wearing the same "Use
        # as my resume" button. The audit trail keeps it; the card doesn't.
        print(f"[optimize] {label}: discarded ({score} < baseline {baseline_score})")
        return None, f"{label}: scored {score} vs your {baseline_score} — discarded, it came out worse"

    if materially_worse:
        # Targeted run: kept so the user still gets the company-shaped
        # document they asked for. run_optimize ships it ONLY if no variant
        # won or tied, and the card carries both numbers.
        who = (target_name or "").strip() or "the role"
        print(f"[optimize] {label}: kept for the target ({score} vs baseline {baseline_score})")
        reason = (f"{label}: {score} vs your {baseline_score} — kept as the "
                  f"version shaped for {who}")
    elif beats:
        print(f"[optimize] {label}: kept ({score} > {baseline_score})")
        reason = f"{label}: {score} vs your {baseline_score} — kept"
    else:
        print(f"[optimize] {label}: kept as a tie ({score} vs baseline {baseline_score})")
        reason = (f"{label}: {score}, level with your {baseline_score} — kept for its "
                  f"cleaner single-column layout")
    # A gate that fired silently is a gate the user has no reason to believe in.
    # When grounding strips an invented line out of an otherwise good rewrite,
    # the variant is still shipped — that is the right call, they get an honest
    # document rather than nothing — but the removal is reported, because "it
    # cannot add a skill you do not have" is the central claim of this product
    # and this is the only place it is ever visibly enforced.
    if dropped:
        reason += f" (removed {len(dropped)} invented entr{'y' if len(dropped) == 1 else 'ies'})"
    meets_floor = score >= readiness.SHIPPABLE_FLOOR
    return {
        "label": label,
        "score": score,
        "grade": report.get("grade") or readiness.grade(score),
        "baseline_score": baseline_score,
        "beats_baseline": beats,
        # Targeted-run keep: scored below the master but shipped anyway as the
        # company-shaped version (see run_optimize's docstring). The UI reads
        # the same fact off score < baseline_score; this flag is for the
        # shipping filter, which must not let losers ride beside winners.
        "materially_worse": materially_worse,
        # Page budget, when one was set, and whether this document met it.
        "page_budget": max_pages,
        "over_budget": bool(max_pages) and over_budget,
        "changes": changes,
        "report": report,
        "fidelity": fidelity,
        "pages": result.pages,
        # Whether this rebuild reached the score we are willing to stand behind,
        # and if not, the one thing standing in the way. Both go to the UI: a
        # document handed over at 74 with no explanation is worse than one
        # handed over at 74 beside the sentence that gets it to 84.
        "meets_floor": meets_floor,
        "floor": readiness.SHIPPABLE_FLOOR,
        "floor_gap": "" if meets_floor else _floor_gap(report),
        # What it takes to promote this rebuild into a resume of its own: the
        # fields it was printed FROM, and the text a parser read back OFF it.
        #
        # Both are already in hand at this point and neither can be recovered
        # later without cost. Re-deriving the struct from the finished PDF means
        # a second extraction pass — model calls, and a worse answer than the
        # one we already hold, because extraction from a rendered page is
        # strictly lossier than the structure we rendered it from. Re-deriving
        # the text means opening the file again.
        #
        # `text` is the extracted reading, deliberately, not a serialisation of
        # the struct: it is what the score was computed from, so a promoted
        # resume opens showing the same number the card showed. Handing over the
        # struct's own prose instead would quietly re-score the document against
        # text no employer will ever see.
        "struct": struct,
        "text": parsed,
        "pdf_bytes": pdf_bytes,
    }, reason


def _render_and_score(
    struct: dict, pdf_path: str, target_keywords: list[str] | None,
    fit_pages: int | None = None,
) -> dict:
    """Render one struct, read the PDF back, score the text that came out.

    Returns either `{"error": str, "rendered": bool}` or a dict carrying the
    render result, the extracted text, the report, the score and the PDF bytes.
    Split out of `_one_variant` so the floor repair can run the exact same
    measurement a second time rather than an approximation of it.

    The PDF is read back rather than the struct being scored directly. Scoring
    the struct measures our intent; scoring the extracted text measures the
    artefact the employer actually receives, which is the only claim this
    product is allowed to make.
    """
    # A user page budget gets a deeper density ladder than the default cap.
    if fit_pages:
        result = render_pdf.render_fitted(
            struct, pdf_path, fit_pages, densities=render_pdf.FIT_RUNGS,
        )
    else:
        result = render_pdf.render_fitted(struct, pdf_path, _MAX_PAGES)
    if not result.ok or not os.path.exists(pdf_path):
        return {"error": f"the document didn't render ({result.reason})", "rendered": False}
    if result.pages and result.pages > _MAX_PAGES:
        return {
            "error": f"came out {result.pages} pages, over the {_MAX_PAGES}-page limit",
            "rendered": True,
        }

    parsed = render_pdf.extract_back(pdf_path)
    n_chars = len((parsed or "").strip())
    if n_chars < 200:
        # Our bug, not the user's resume. The caller keeps the evidence: without
        # the HTML and the PDF there is no way to tell an empty render from a
        # font that carries no extractable text.
        return {
            "error": f"the rendered PDF came out unreadable ({n_chars} chars) — a bug on our side",
            "rendered": True,
        }

    report = readiness.score(parsed, target_keywords)
    with open(pdf_path, "rb") as f:
        pdf_bytes = f.read()
    return {
        "result": result,
        "parsed": parsed,
        "report": report,
        "score": int(report.get("score") or 0),
        "pdf_bytes": pdf_bytes,
    }


# ---------------- the shippable floor ----------------

# Headings that mean "Education" / "Technical Skills" / "Experience" to a human
# but not to `readiness.SECTION_PATTERNS`, and therefore not to an ATS either.
# Renaming these is not cosmetic: a section a parser cannot classify is a block
# of the resume it drops on the floor.
_HEADING_CANON: list[tuple[re.Pattern, str]] = [
    (re.compile(r"^\s*(?:academic|scholastic)\b.*|^\s*schooling\b.*", re.I), "Education"),
    (re.compile(r"^\s*(?:technical\s+)?(?:proficienc|expertise|toolkit|tech\s*stack)\w*\b.*", re.I),
     "Technical Skills"),
    (re.compile(r"^\s*(?:career|employment|professional)\s+(?:history|journey|background|summary\s+of\s+roles)\b.*", re.I),
     "Experience"),
    (re.compile(r"^\s*(?:my\s+)?journey\b.*|^\s*where\s+i(?:'ve)?\s+worked\b.*", re.I), "Experience"),
]


def _canonicalise_headings(struct: dict) -> list[str]:
    """Rename headings a parser cannot classify. Returns what was renamed."""
    renamed: list[str] = []
    taken = {str(s.get("heading") or "").strip().lower() for s in struct.get("sections") or []}
    for sec in struct.get("sections") or []:
        heading = str(sec.get("heading") or "").strip()
        if not heading:
            continue
        for pattern, canonical in _HEADING_CANON:
            if pattern.match(heading) and canonical.lower() not in taken:
                sec["heading"] = canonical
                taken.add(canonical.lower())
                renamed.append(f"{heading} → {canonical}")
                break
    return renamed


def _skills_section(master_skills: list[str]) -> dict | None:
    """A Technical Skills section built from the candidate's OWN skill list.

    `master_skills` is what `resume_parse.extract_skills` read off their resume,
    which is the same list every rewrite is checked against. Printing it back
    adds no claim they have not already made — it moves a claim out of prose,
    where a keyword search misses it, into the block a recruiter searches.
    """
    skills = [s.strip() for s in (master_skills or []) if s and s.strip()]
    if len(skills) < 3:
        return None
    return {
        "heading": "Technical Skills",
        "items": [{"head": "Skills", "sub": "", "bullets": skills[:24]}],
    }


def _repair_for_floor(struct: dict, report: dict, master_skills: list[str]) -> list[str]:
    """Fix, in place, the score deficits that are OURS rather than the user's.

    Runs only when a rendered variant lands below `readiness.SHIPPABLE_FLOOR`.
    Every repair here is mechanical and adds no fact: it either renames a
    heading a parser cannot classify, or prints back a skill the candidate
    already claimed. Returns the repairs applied, empty if none were possible.

    What it deliberately does NOT do is anything that would raise the score by
    changing what the resume says. A thin resume stays thin, a resume with no
    dates stays undated, and bullets with no numbers do not acquire any. Those
    gaps are reported to the user as gaps. A "guaranteed 80" that is reached by
    writing the missing content is not a guarantee, it is a fabrication with a
    number attached to it.
    """
    bands = report.get("bands") or {}
    facts = report.get("facts") or {}
    repairs: list[str] = []

    if (bands.get("structure") or {}).get("score", 100) < 100:
        sections = (facts.get("structure") or {}).get("sections") or {}
        renamed = _canonicalise_headings(struct)
        if renamed:
            repairs.append("renamed sections a parser could not classify: " + ", ".join(renamed))
        if not sections.get("skills") and not any(
            _SKILLS_SECTION_RE.search(str(s.get("heading") or ""))
            for s in struct.get("sections") or []
        ):
            block = _skills_section(master_skills)
            if block:
                struct.setdefault("sections", []).append(block)
                repairs.append("added a Technical Skills section from the skills already on your resume")

    return repairs


def _floor_gap(report: dict) -> str:
    """The single most useful sentence about why a variant is under the floor.

    One reason, not a list. A user looking at a 74 wants to know the one thing
    to change, and the bands are not equally actionable — a resume that reads as
    a scan cannot be improved by adding numbers to its bullets.
    """
    bands = report.get("bands") or {}

    def short(name: str) -> float:
        band = bands.get(name) or {}
        return (band.get("weight") or 0) - (band.get("points") or 0)

    worst = max(("readable", "fields", "structure", "impact", "coverage"),
                key=lambda n: short(n) if n in bands else -1.0)
    for finding in report.get("findings") or []:
        if finding.get("band") == worst:
            return finding.get("fix") or finding.get("problem") or ""
    return ""


def _fact_strings(struct: dict) -> list[str]:
    """Every discrete claim the struct makes, as strings, for fidelity checking.

    Headings are excluded — a heading is our word, not the candidate's fact, and
    counting it would inflate the recovery rate with text we chose ourselves.
    """
    facts: list[str] = []
    for sec in struct.get("sections") or []:
        for item in sec.get("items") or []:
            for key in ("head", "sub"):
                val = str(item.get(key) or "").strip()
                if val:
                    facts.append(val)
            for b in item.get("bullets") or []:
                b = str(b or "").strip()
                if b:
                    facts.append(b)
    return facts


def _dump_debug(debug_dir: str | None, label: str, tex: str, pdf_path: str | None) -> None:
    """Save the artefacts of a variant that failed to render or parse.

    Best-effort and silent on failure — a debugging aid must never be able to
    take down the run it is trying to explain.
    """
    if not debug_dir:
        return
    try:
        os.makedirs(debug_dir, exist_ok=True)
        slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "variant"
        with open(os.path.join(debug_dir, f"{slug}.html"), "w", encoding="utf-8") as f:
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
    "the resume clearly has). If the resume opens with a summary, profile or "
    "objective paragraph, keep it as its own section headed 'Professional "
    "Summary', with the paragraph as a single bullet — do not drop it and do not "
    "fold it into another section. It is the first thing a human reads and it "
    "was going missing. For a skills section, put each skill group as one "
    "bullet like 'Languages: Python, Java, SQL'. 'head' is a title (role, project "
    "name, or degree); 'sub' is the right-aligned meta (dates, company, tech, "
    "CGPA) or an empty string. Copy facts verbatim — do not add, embellish, or "
    "invent. No markdown, no prose outside the JSON."
)


def _item_count(struct: dict | None) -> int:
    if not struct:
        return 0
    return sum(len(sec.get("items") or []) for sec in struct.get("sections") or [])


def _bullet_count(struct: dict | None) -> int:
    """Bullets outside the skills block.

    Skills are excluded because a rewrite regroups them freely — six one-word
    bullets under "Languages" legitimately become one line reading "Languages:
    Python, SQL, Java" — so counting them would read every good skills rewrite
    as content loss.
    """
    if not struct:
        return 0
    return sum(
        len(item.get("bullets") or [])
        for sec in struct.get("sections") or []
        if not _SKILLS_SECTION_RE.search(str(sec.get("heading") or ""))
        for item in sec.get("items") or []
    )


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
        f'Resume text:\n"""\n{text[:_PROMPT_TEXT_CHARS]}\n"""\n\n'
        "Return the structured JSON object described in your instructions."
    )
    # One round of provider calls, merged locally. chat_json_ensemble would do the
    # same calls and then throw the responses away, leaving a failed merge with
    # nothing to fall back on but a second full round — and the merge fails on
    # every real resume tried so far, so that second round was the normal path:
    # six provider calls and twice the latency for the same three answers.
    dicts = [
        parsed for parsed in (llm_mod._extract_json(raw)
                              for raw in llm_mod.chat_ensemble(prompt, system=_EXTRACT_SYS, n=3, timeout=90,
                                                               temperature=0.0)
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
        f"Resume JSON to rewrite:\n{json.dumps(base_struct, ensure_ascii=False)[:_PROMPT_JSON_CHARS]}\n\n"
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
    # Why a rewrite came back empty is two different sentences to the user:
    # "every provider failed" versus "the providers answered but none of the
    # answers could be read as JSON" (cut off, malformed). The second used to
    # be reported as the first. Counted here, read by _one_variant.
    _REWRITE_DIAG["answers"] = 0
    _REWRITE_DIAG["parsed"] = 0
    for raw in llm_mod.chat_ensemble(prompt, system=_REWRITE_SYS, n=3, timeout=120):
        _REWRITE_DIAG["answers"] += 1
        parsed = llm_mod._extract_json(raw)
        if not isinstance(parsed, dict):
            continue
        _REWRITE_DIAG["parsed"] += 1
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

    # Abbreviation <-> expansion, both directions. A resume that says "machine
    # learning" has every right to be rewritten as "ML", and one that says
    # "NLP" as "natural language processing" — the same fact, the other
    # spelling. Without this the gate rejected the whole variant for
    # "inventing" a skill the candidate had written out in full (the plural
    # and derivation folds do not reach across an acronym). Phrase-level on
    # purpose: the acronym is granted only when the WHOLE phrase is present,
    # so "programming language" alone never defends "nlp".
    text_l = (source_text or "").lower() + " " + " ".join(master_skills or []).lower()
    text_l = re.sub(r"[\s\-]+", " ", text_l)
    for abbr, phrase in _ABBREVIATIONS.items():
        if phrase in text_l:
            allowed.add(abbr)
        if abbr in allowed:
            allowed.update(phrase.split())
    return allowed


# Acronyms a resume may spell out or not. Keys are the acronym as a token,
# values the full phrase (lowercase, single-spaced). Used by _allowed_tokens
# in both directions. Extend here, not in the gate.
_ABBREVIATIONS: dict[str, str] = {
    "ml": "machine learning",
    "ai": "artificial intelligence",
    "nlp": "natural language processing",
    "cv": "computer vision",
    "dl": "deep learning",
    "rl": "reinforcement learning",
    "llm": "large language model",
    "llms": "large language models",
    "genai": "generative ai",
    "rag": "retrieval augmented generation",
    "ci": "continuous integration",
    "cd": "continuous delivery",
    "ui": "user interface",
    "ux": "user experience",
    "api": "application programming interface",
    "oop": "object oriented programming",
    "dsa": "data structures and algorithms",
    "sdlc": "software development life cycle",
    "tdd": "test driven development",
    "aws": "amazon web services",
    "gcp": "google cloud platform",
    "k8s": "kubernetes",
    "db": "database",
    "iot": "internet of things",
    "etl": "extract transform load",
    "bi": "business intelligence",
}


def _tech_vocab() -> frozenset[str]:
    """Every technology name either module knows, as one lowercase set.

    `_fabricated_skills` used to check `resume_parse.KNOWN_SKILLS` alone — 60
    strings. Anything outside it ("Kafka", "Terraform", "Snowflake",
    "Elasticsearch", "Jenkins", "Hadoop", "Spark") could be invented freely, and
    an adversarial run proved every one of those passed. `jobspec.VOCAB` already
    lists ~200 more because it has to recognise them in job descriptions; there
    was no reason for the gate to know less than the parser.
    """
    vocab = {s.lower() for s in resume_parse.KNOWN_SKILLS}
    try:
        import jobspec

        vocab |= {s.lower() for s in jobspec.VOCAB}
    except Exception:  # noqa: BLE001 - the gate must work even if that import breaks
        pass
    # Multi-word entries are matched by their parts too, since a bullet says
    # "Kafka" where the vocabulary says "apache kafka".
    for entry in list(vocab):
        for part in entry.split():
            if len(part) > 2:
                vocab.add(part)
    return frozenset(vocab)


TECH_VOCAB = _tech_vocab()


def _fabricated_skills(struct: dict, allowed: set[str]) -> list[str]:
    """Known tech skills that appear in the variant but NOT in the source — i.e.
    invented. Rewording English prose is fine; introducing 'kubernetes' or 'aws'
    the candidate never listed is not. Checked against a technology vocabulary
    rather than against every word, so ordinary rewrite wording does not trip it.

    The vocabulary is TECH_VOCAB, not the 60-string KNOWN_SKILLS this used to
    read: anything outside that short list was previously free to invent.
    """
    # Identity is excluded, and this is a correctness rule rather than an
    # optimisation. The name and contact line are not model output: they are
    # lifted from the raw source by `_identity_from_source` and stamped on
    # afterwards, so by construction they cannot be something a rewrite
    # invented. Scanning them turned real headers into fabrications — a
    # recovered "github.com/priya-r" contains the vocabulary word "github" and
    # the token "r", neither of which the candidate had "claimed as a skill",
    # so EVERY variant was rejected with "it invented skills you don't have
    # (github, r)" the moment the profile-link recovery started working. A
    # candidate named Ruby, or one whose employer is Kotlin Labs, would have hit
    # the same wall.
    blob = _flatten(struct, include_identity=False).lower()
    allowed_stems = {_stem(a) for a in allowed if len(a) >= 6}
    bad: list[str] = []
    for sk in sorted(TECH_VOCAB):
        present = re.search(r"(?<![a-z])" + re.escape(sk) + r"(?![a-z])", blob)
        if not present:
            continue
        # Is every token of this multi-word skill defensible from the source?
        #
        # Morphology is folded here, not just exact membership. `_allowed_tokens`
        # records what the source literally wrote — "APIs" — so a rewrite saying
        # "REST API" was reported as having invented "api" and the WHOLE variant
        # was rejected with "it invented skills you don't have (api)". The two
        # halves of one gate disagreed about English plurals.
        if all(
            tok in allowed
            or bool(_morph_variants(tok) & allowed)
            or _stem_defended(tok, allowed_stems, allowed)
            for tok in re.findall(r"[a-z0-9+#.]+", sk)
        ):
            continue
        bad.append(sk)
    return bad


def _flatten(struct: dict, include_identity: bool = True) -> str:
    parts: list[str] = (
        [str(struct.get("name") or ""), str(struct.get("contact_line") or "")]
        if include_identity else []
    )
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
# Field separators a contact header is built from. The pipe covers most source
# resumes; the middot is what OUR OWN template prints, and a user who downloads
# a Grindly rebuild and uploads it again must not have their header collapse
# into one unsplittable segment. `_GLYPH_RE` erases the middot a line later, so
# splitting has to happen first.
_SEP_RE = re.compile(r"\s*[|•·∙]\s*")
_PLACEHOLDER_RE = re.compile(r"\[[^\]]*redact[^\]]*\]", re.I)
# A document title is not a name. Plenty of templates open with "Curriculum Vitae"
# or "RESUME" on its own line, which passes every other test for a person's name.
_NOT_A_NAME = frozenset({"resume", "curriculum", "vitae", "cv", "profile", "summary", "biodata"})


# Profile hosts worth printing in a header. Deliberately short: a link
# annotation on a resume can point at anything — a certificate, a company
# website, a Google Doc — and appending all of them turns the header into a
# link dump. These are the ones a recruiter looks for and an application form
# asks for by name.
_PROFILE_HOSTS = (
    "linkedin.com", "github.com", "gitlab.com", "kaggle.com",
    "behance.net", "dribbble.com", "medium.com", "leetcode.com",
    "scholar.google.com", "orcid.org", "stackoverflow.com",
)


def _display_url(url: str) -> str:
    """A URL as it should read on a printed page: no scheme, no www, no slash."""
    u = re.sub(r"^https?://", "", (url or "").strip(), flags=re.I)
    u = re.sub(r"^www\.", "", u, flags=re.I)
    return u.rstrip("/")


def _merge_profile_links(contact: str, links: list[str] | None) -> str:
    """Fold profile URLs from the PDF's link annotations into the contact line.

    This recovers a real, fixable loss rather than adding anything. Most resumes
    put their LinkedIn behind the *word* "LinkedIn", or behind a bare handle —
    "mahendhar-sammeta" — with the actual address living only in the PDF's link
    annotation. A text extractor never sees it, so `readiness._band_fields`
    reports "no LinkedIn or GitHub link is visible", correctly: the URL is not
    in the document a parser reads, and an application form that asks for a
    profile URL gets nothing. The address is the candidate's own and it is
    already in the file they uploaded; printing it as text is the whole fix.

    A bare handle already on the line is REPLACED by the full URL rather than
    joined by it, so the header does not read "mahendhar-sammeta ·
    linkedin.com/in/mahendhar-sammeta".
    """
    line = (contact or "").strip()
    chosen: list[str] = []
    for raw in links or []:
        display = _display_url(raw)
        host = display.split("/", 1)[0].lower()
        if not any(host == h or host.endswith("." + h) for h in _PROFILE_HOSTS):
            continue
        if any(host in seen.lower() for seen in chosen):
            continue          # one link per host — the first is the profile
        if host in line.lower():
            continue          # the address is already printed as text
        chosen.append(display)
        if len(chosen) >= 3:
            break

    for display in chosen:
        handle = display.rstrip("/").rsplit("/", 1)[-1]
        # Replace a bare handle standing in for this URL, if one is on the line.
        if handle and len(handle) >= 4:
            pattern = re.compile(rf"(?<![\w/.-]){re.escape(handle)}(?![\w/.-])")
            replaced, n = pattern.subn(display, line, count=1)
            if n:
                line = replaced
                continue
        line = f"{line} | {display}" if line else display
    return line


def _identity_from_source(
    text: str, contact_fallback: str = "", links: list[str] | None = None,
) -> tuple[str, str]:
    """(name, contact_line) read from the RAW resume, before any redaction.

    Everything the model returns for these two fields is placeholder text — the
    LLM boundary redacts PII on the way out, so "[email redacted]" is a faithful
    copy of what it was shown. Taking the header off the source locally is the
    only way the compiled PDF carries a real phone number.

    `links` are the PDF's link annotations, which carry addresses the text layer
    does not — see `_merge_profile_links`.
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
    contact = contact or _clean_contact_line(contact_fallback)
    return name, _merge_profile_links(contact, links)


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
    segments = [s.strip() for s in _SEP_RE.split(cleaned) if s.strip()]

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
    for seg in _SEP_RE.split(_CID_RE.sub("", line or "")):
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
        # ...and each half of a slashed figure, because the CHECKER splits on
        # "/" before asking (`_ungrounded_tokens`) and this side did not.
        #
        # "CGPA: 8.4/10" is on essentially every Indian student's resume. It was
        # registered here only as the single token "8.4/10", while the gate came
        # back asking whether "8.4" was grounded — it was not, so the Education
        # entry was deleted as invented from every variant, the documents lost
        # their degree, and all three then scored below the master and were
        # discarded. The feature failed completely and silently for the exact
        # market it was built for, and the audit trail blamed the user's resume:
        # "not in your resume (8.4)".
        for part in raw.split("/"):
            if part:
                stems |= _number_aliases(part)
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


# Expansions a rewrite is allowed to make because they are the SAME fact
# written out. Every one of these was rejected as an invented claim by a gate
# that compared surface tokens: "Bachelor of Technology" against a source
# saying "B.Tech", "RESTful" against "REST", "August" against "Aug". A user
# whose truthful rewrite is refused as a fabrication learns not to trust the
# gate, which is worse than the gate not existing.
_EQUIVALENTS: dict[str, tuple[str, ...]] = {
    # `_source_stems` splits "B.Tech" on the dot, so the source contributes "b"
    # and "tech" — never "btech". The aliases have to name the parts that
    # actually land in the stem set, or "Bachelor of Technology" is rejected as
    # an invented degree.
    "bachelor": ("btech", "tech", "be", "bsc", "bcom", "bca", "ba"),
    "technology": ("btech", "tech"),
    "engineering": ("be", "btech", "tech"),
    "master": ("mtech", "tech", "msc", "mba", "mca"),
    "convolutional": ("cnn",),
    "recurrent": ("rnn",),
    "network": ("cnn", "rnn", "nn", "ann", "networks"),
    "networks": ("cnn", "rnn", "nn", "ann", "network"),
    "application": ("api", "app", "apis"),
    "programming": ("api", "apis"),
    "interface": ("api", "apis", "ui"),
    "restful": ("rest",),
    "convolutional": ("cnn",),
    "neural": ("cnn", "nn", "ann"),
    "quality": ("qa",),
    "assurance": ("qa",),
    "january": ("jan",), "february": ("feb",), "march": ("mar",),
    "april": ("apr",), "june": ("jun",), "july": ("jul",),
    "august": ("aug",), "september": ("sep", "sept"), "october": ("oct",),
    "november": ("nov",), "december": ("dec",),
    "bengaluru": ("bangalore",), "bangalore": ("bengaluru",),
    "mumbai": ("bombay",), "chennai": ("madras",),
    "postgres": ("postgresql",), "postgresql": ("postgres",),
    "kubernetes": ("k8s",), "javascript": ("js",), "typescript": ("ts",),
}


# Derivational suffixes, longest first. Stripped once, and only when at least
# four characters remain — "spring" → "spr" is too short to fold, so "spring"
# (the framework) is NOT defended by "sprint" (the ceremony).
_DERIV_SUFFIXES = (
    "ization", "isation", "ations", "ation", "ments", "ment", "ings", "ing",
    "ers", "ies", "ied", "ical", "ics", "ity", "ed", "er", "es", "is", "ic",
    "ly", "al", "s",
)


def _stem(token: str) -> str:
    """A crude, deliberately narrow stem for DERIVED forms of one English word.

    `_morph_variants` folds plurals; this folds the next ring out — "analysis"
    / "analyzing" / "analysed", "management" / "managed", "engineering" /
    "engineer". Seen live: the resume said "analyzing", the rewrite wrote
    "data analysis", and the gate rejected the WHOLE variant for inventing
    "analysis" — all three rewrites of a targeted run died on wording.

    Narrow on purpose, because this loosens the truthfulness gate: one suffix
    stripped, never two; the stem must keep four characters; trailing e/y and
    the American z are normalised so "analyse"/"analyze"/"analysis" agree.
    Tech names rarely carry these suffixes, and the short ones ("go", "c",
    "sql", "react") are never folded at all — see the length guard at the
    call site.
    """
    t = token.lower().strip("./-")
    for suf in _DERIV_SUFFIXES:
        if t.endswith(suf) and len(t) - len(suf) >= 4:
            t = t[: -len(suf)]
            break
    return t.rstrip("ey").replace("z", "s")


def _stem_defended(token: str, allowed_stems: set[str], allowed_words: set[str]) -> bool:
    """Is this rewrite token a derived form of a word the source wrote?"""
    if len(token) < 6:
        return False
    stem = _stem(token)
    # Either both reduce to one stem ("analysis"/"analyzing" → "analys"), or
    # the stem IS a word the source wrote ("engineering" → "engineer").
    return stem in allowed_stems or stem in allowed_words


def _morph_variants(token: str) -> set[str]:
    """Forms of one word that mean the same thing.

    Plural/singular folding is the important half. `_allowed_tokens` records
    exactly what the source wrote — "APIs" — while a rewrite writing "API" was
    reported as an invented skill and the ENTIRE variant was rejected with
    "it invented skills you don't have (api)". The two halves of one gate
    disagreed about English.
    """
    t = token.lower().strip("./-")
    out = {t}
    if t.endswith("ies") and len(t) > 4:
        out.add(t[:-3] + "y")
    if t.endswith("es") and len(t) > 3:
        out.add(t[:-2])
    if t.endswith("s") and len(t) > 2:
        out.add(t[:-1])
    else:
        out.add(t + "s")
    out.update(_EQUIVALENTS.get(t, ()))
    # And the reverse direction: source "B.Tech", rewrite "Bachelor".
    for canonical, aliases in _EQUIVALENTS.items():
        if t in aliases:
            out.add(canonical)
    return {v for v in out if v}


def _is_grounded(tok: str, stems: set[str]) -> bool:
    """A token is grounded if the master resume can defend it.

    Digits are exact-match: a year or a metric is a claim, and "2020" is not
    supported by "2021". Words match on stem and on morphology, so rewording
    stays free — that latitude is what keeps the gate from rejecting honest
    rewrites, which it did for 56% of a measured sample before the equivalence
    and plural handling below existed.
    """
    t = tok.strip("./-").lower()
    if not t:
        return True
    if t.isdigit():
        return t in stems
    if t in _FREE_WORDS or len(t) < 4:
        return True
    if t in stems or (len(t) >= 5 and t[:5] in stems):
        return True
    return any(
        v in stems or (len(v) >= 5 and v[:5] in stems)
        for v in _morph_variants(t)
    )


# A token inside a bullet that must be defensible even though the surrounding
# prose is free to change. Two independent tells, because each alone leaks:
#
#   * Capitalised mid-sentence. "Kafka", "Terraform", "Snowflake", "Jenkins" —
#     product and company names are proper nouns, and ordinary rewording words
#     ("owned", "streaming", "pipeline") are not.
#   * In the technology vocabulary, regardless of case. Catches "kubernetes"
#     written in lower case, which the capitalisation rule alone would miss.
#
# What is deliberately NOT checked is every word: a rewrite exists to reword, and
# demanding that "spearheaded" appear in the source would reject every honest
# variant. The line is between rephrasing a fact and naming a new one.
_SENTENCE_START_RE = re.compile(r"^\W*\w")


# Words a rewrite may capitalise without it being a claim about a product or an
# employer. Sentence-initial capitals are already handled; these are the ones
# that show up mid-sentence in ordinary resume prose.
_CAPITALISED_NOT_A_NAME = frozenset("""
I Built Led Wrote Designed Developed Implemented Reduced Increased Improved
Automated Managed Created Delivered Achieved Deployed Migrated Optimised
Optimized Analysed Analyzed Tested Maintained Owned Drove Launched Shipped
Collaborated Partnered Presented Mentored Trained Researched Engineered
""".split())

# A run of capitalised words that is a real acronym or product name has at
# least this many characters. Two- and three-letter tokens are exempt from
# grounding anyway (see _is_grounded), which is itself a hole — ECS, IAM, SQS,
# JWT and K8s are freely inventable — so short capitalised tokens that ARE in
# the technology vocabulary are checked explicitly here instead.
_SHORT_TECH_MIN = 2


def _bullet_claim_tokens(bullet: str) -> list[str]:
    """Proper nouns and technology names asserted by one bullet.

    Three tells, in order of reliability:

      * the token is in the technology vocabulary, in ANY case — this is what
        catches "pinecone" and "weaviate" written in lower case, which the
        capitalisation rule alone misses entirely;
      * it is capitalised mid-sentence and is not an ordinary resume verb;
      * it is a short uppercase acronym that the vocabulary knows.
    """
    text = str(bullet or "")
    out: list[str] = []
    first = True
    for match in re.finditer(r"[A-Za-z][A-Za-z0-9+#.\-]*", text):
        tok = match.group(0)
        is_first_word = first
        first = False
        low = tok.lower().strip(".-")
        if not low or low in _FREE_WORDS:
            continue

        in_vocab = low in TECH_VOCAB
        # Short all-caps tokens are acronyms; they slip past the length exemption
        # in _is_grounded, so they are named as claims here.
        acronym = len(tok) >= _SHORT_TECH_MIN and tok.isupper() and not tok.isdigit()
        capitalised = (
            tok[0].isupper()
            and not is_first_word
            and tok not in _CAPITALISED_NOT_A_NAME
        )
        if in_vocab or acronym or capitalised:
            out.append(tok)
    return out


def ungrounded_in_bullet(bullet: str, stems: set[str]) -> list[str]:
    """Named things and numbers in ONE bullet that the master cannot defend."""
    bad: list[str] = []
    seen: set[str] = set()

    def flag(tok: str) -> None:
        if tok.lower() not in seen:
            seen.add(tok.lower())
            bad.append(tok)

    for raw in _bullet_claim_tokens(bullet):
        for tok in re.split(r"[/]", raw):
            tok = tok.strip(".-")
            if tok and not _is_grounded(tok, stems):
                flag(tok)
    # Numbers that START a token only. A digit glued behind a word is part of a
    # tool name — "YOLOv8" is not a claim that something happened eight times.
    for raw in _NUM_TOKEN_RE.findall(str(bullet)):
        if not _number_grounded(raw, stems):
            flag(raw)
    return bad


def _title_ungrounded(item: dict, stems: set[str]) -> list[str]:
    """Words in an item's head/sub the master cannot defend.

    This is what catches "XYZ Corp" and "University of Technology | 2020" — an
    employer, school or date the candidate never had. Kept separate from the
    bullet check because the remedy differs: an invented title means the entry is
    fiction, an invented bullet means one sentence is.
    """
    bad: list[str] = []
    seen: set[str] = set()
    for field in ("head", "sub"):
        value = str(item.get(field) or "")
        for raw in re.findall(r"[A-Za-z0-9][A-Za-z0-9+#./-]*", value):
            # "AI/ML" is two tokens. _source_stems splits on the separators, so a
            # checker that doesn't would flag a word the resume plainly has.
            for tok in re.split(r"[/]", raw):
                if not tok:
                    continue
                ok = _number_grounded(tok, stems) if tok[0].isdigit() else _is_grounded(tok, stems)
                if not ok and tok.lower() not in seen:
                    seen.add(tok.lower())
                    bad.append(tok)
    return bad


def _ungrounded_tokens(item: dict, stems: set[str], check_title: bool = True) -> list[str]:
    """Words in an item's title/meta, plus NUMBERS and NAMED THINGS in its
    bullets, that the master resume cannot defend.

    This catches "XYZ Corp", "University of Technology | 2020" and "Achieved 30
    FPS" — and, since the fix below, "Owned the Kafka streaming pipeline".

    Bullet PROSE used to be exempt entirely: only numbers were checked inside a
    bullet, and only the 60-string KNOWN_SKILLS vocabulary was checked anywhere.
    An adversarial run walked straight through all three gates with "Owned the
    Kafka streaming pipeline and the Terraform infrastructure end to end" and a
    skills group reading "Apache Kafka, Terraform, Snowflake, Elasticsearch,
    Jenkins, Hadoop, Spark" — none of it in the source, nothing flagged, all of
    it rendered into the PDF the candidate sends to an employer. The product's
    entire differentiator is that this cannot happen, so it now cannot.

    `check_title=False` for a skills group, whose head is a CATEGORY the rewrite
    invented for grouping ("Frontend", "Backend", "AI/ML & Vision") and not a
    claim about the candidate. Checking those cost a live run all three variants:
    eight grouping labels were deleted as "not in your resume", the documents
    came out nearly empty, and they scored 20-35 against an 88 master. Their
    BULLETS are still checked — those are the skill names themselves.
    """
    bad: list[str] = []

    def flag(tok: str) -> None:
        if tok.lower() not in {b.lower() for b in bad}:
            bad.append(tok)

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
                    if not ok:
                        flag(tok)

    for b in item.get("bullets") or []:
        bad.extend(t for t in ungrounded_in_bullet(b, stems)
                   if t.lower() not in {x.lower() for x in bad})
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
            # Two different remedies, because the two failures mean different
            # things. An ungrounded EMPLOYER, school or date invalidates the whole
            # entry — there is no such job. An ungrounded BULLET is one invented
            # sentence inside a real job, and deleting the job over it would cost
            # the user the two true bullets beside it. So titles drop the item;
            # bullets drop only themselves.
            if not skillsy:
                bad_title = _title_ungrounded(item, stems)
                if bad_title:
                    dropped.append(
                        f"{heading}/{label}: not in your resume ({', '.join(bad_title[:3])})"
                    )
                    continue
            else:
                # A skills group's head is a CATEGORY the rewrite invented for
                # grouping ("Frontend", "Databases"), so it is not grounded as a
                # whole — but it is not a free-text field either. A rewrite that
                # wrote `head: "Vector DBs: Pinecone, Weaviate, Milvus"` with no
                # bullets at all put four technologies the candidate had never
                # touched onto the page, because only bullets were being checked.
                head_claims = [
                    t for t in _bullet_claim_tokens(str(item.get("head") or ""))
                    if not _is_grounded(t, stems)
                ]
                if head_claims:
                    dropped.append(
                        f"{heading}/{label}: not in your resume ({', '.join(head_claims[:3])})"
                    )
                    continue

            clean_bullets: list[str] = []
            for b in item.get("bullets") or []:
                if skillsy:
                    # A skills group's bullets ARE the claims: each entry is a
                    # technology the candidate says they know, so every token of
                    # it has to appear in the source.
                    tokens = [
                        t for raw in re.split(r"[,;/]", str(b))
                        for t in re.findall(r"[A-Za-z0-9][A-Za-z0-9+#.\-]*", raw)
                    ]
                    # Short tokens are exempt from _is_grounded's length rule,
                    # which made "ECS", "IAM", "SQS", "JWT" and "K8s" freely
                    # inventable in a skills list. In a skills group every entry
                    # is a claim regardless of length, so they are checked
                    # directly against the source's own tokens.
                    bad_bullet = [
                        t for t in tokens
                        if t and (
                            not _is_grounded(t, stems)
                            or (
                                len(t.strip("./-")) < 4
                                and t.lower().strip("./-") not in _FREE_WORDS
                                and not any(v in stems for v in _morph_variants(t))
                            )
                        )
                    ]
                else:
                    bad_bullet = ungrounded_in_bullet(b, stems)
                if bad_bullet:
                    dropped.append(
                        f"{heading}/{label}: not in your resume ({', '.join(bad_bullet[:3])})"
                    )
                else:
                    clean_bullets.append(b)

            had_bullets = bool(item.get("bullets"))
            if had_bullets and not clean_bullets:
                # Every bullet was invented. Whatever this entry was, it is not
                # something the master resume supports.
                continue
            item = {**item, "bullets": clean_bullets}

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


# ---------------- sanitizers ----------------

def _coerce_bullets(raw: object) -> list[str]:
    """Bullets, from whatever the model actually returned.

    A plain string is ONE bullet, never an iterable of characters. Iterating it
    is the bug this whole path exists to stop: `[b for b in "Python, React"]`
    emits one \\item per letter, which still compiles, still clears the length
    check, and reaches the user as a resume of single characters.
    """
    # Length capping happens HERE, not in the renderer. The LaTeX renderer used
    # to truncate every bullet to _MAX_BULLET_CHARS on its way out, so the cap
    # silently lived in the one function that has now been replaced. Moving it
    # into the sanitizer keeps it on the path every consumer shares — the PDF
    # render, the fidelity check, and the JSON the API returns — instead of
    # applying to the PDF alone and letting a 4,000-character bullet through to
    # everything else.
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        # Models often pack several bullets into one string.
        parts = [p.strip(" -•\t") for p in re.split(r"[\r\n]+|(?<=[.;])\s{2,}", text)]
        return [p[:_MAX_BULLET_CHARS] for p in parts if p][:_MAX_BULLETS]
    if isinstance(raw, list):
        return [
            str(b).strip()[:_MAX_BULLET_CHARS]
            for b in raw if str(b).strip()
        ][:_MAX_BULLETS]
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
            "head": str(it.get("head") or it.get("title") or "").strip()[:_MAX_HEAD_CHARS],
            "sub": str(it.get("sub") or it.get("subtitle") or "").strip()[:_MAX_HEAD_CHARS],
            # "content"/"points" are the aliases seen most often after "bullets".
            "bullets": _coerce_bullets(
                it.get("bullets") if it.get("bullets") is not None
                else it.get("content") if it.get("content") is not None
                else it.get("points")
            ),
        })
    return items


def _sanitize_struct(struct: dict) -> dict | None:
    """Coerce an LLM struct into the exact shape render_pdf.build_html expects.

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
            # A heading with nothing under it is dropped.
            #
            # Every renderer prints the heading it is given, so a section the
            # model named and then left empty came out as a bare "PROFESSIONAL
            # SUMMARY" with white space beneath it — in the PDF, the .docx and
            # the plain-text export alike. Seen on the live site: extraction
            # invented that exact heading from a resume that has no summary, and
            # it reached the exported documents.
            #
            # It also costs the user points. readiness.py scores structure partly
            # on sections, and an empty one is a heading a parser indexes with no
            # content behind it.
            if not any(
                item.get("head") or item.get("sub") or item.get("bullets")
                for item in items
            ):
                continue
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
