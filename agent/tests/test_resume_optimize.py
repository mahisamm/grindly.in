"""_sanitize_struct — the shape gate between an LLM rewrite and a real PDF.

Two failures meet here and pull in opposite directions:

  * Too strict, and an off-shape response loses all its content. The render
    produces a ~100-character .tex, the compiled PDF trips the readability
    check, and every variant comes back "the compiled PDF came out unreadable —
    a bug on our side". Seen live, all three variants at once.

  * Too loose, and a `bullets` that arrived as a plain string gets iterated
    character by character — one \\item per letter. That still compiles, still
    clears the length check, gets scored and stored, and is offered behind a
    button that overwrites the user's real master resume.

So: coerce every shape a model actually emits, but never iterate a string.
"""
import pytest

import resume_optimize as ro


def _counts(struct):
    r = ro._sanitize_struct(struct)
    assert r is not None, "usable content was dropped"
    items = sum(len(s["items"]) for s in r["sections"])
    bullets = sum(len(i["bullets"]) for s in r["sections"] for i in s["items"])
    return len(r["sections"]), items, bullets


def test_the_canonical_shape_survives_untouched():
    assert _counts({
        "name": "A B", "contact_line": "a@b.com",
        "sections": [{"heading": "PROJECTS", "items": [
            {"head": "Grindly", "sub": "2026", "bullets": ["Built X", "Shipped Y"]}]}],
    }) == (1, 1, 2)


def test_items_given_as_plain_strings_are_kept():
    """Common for a SKILLS section."""
    assert _counts({
        "name": "A", "contact_line": "c",
        "sections": [{"heading": "SKILLS", "items": ["Python, React", "SQL"]}],
    }) == (1, 2, 2)


def test_sections_given_as_a_dict_are_kept():
    assert _counts({
        "name": "A", "contact_line": "c",
        "sections": {"SKILLS": ["Python", "React"]},
    }) == (1, 2, 2)


@pytest.mark.parametrize("alias", ["content", "points"])
def test_bullet_aliases_are_accepted(alias):
    assert _counts({
        "name": "A", "contact_line": "c",
        "sections": [{"heading": "S", "items": [{"head": "h", alias: ["Python"]}]}],
    }) == (1, 1, 1)


def test_a_string_of_bullets_is_one_bullet_not_one_per_character():
    """The failure that actually reaches a recruiter."""
    out = ro._coerce_bullets("Python, React, SQL")
    assert out == ["Python, React, SQL"]
    assert len(out) == 1


def test_a_multiline_string_splits_into_real_bullets():
    out = ro._coerce_bullets("Built the API\nShipped the UI\n- Wrote tests")
    assert out == ["Built the API", "Shipped the UI", "Wrote tests"]


def test_a_skeletal_extraction_is_kept_not_rejected():
    """_sanitize_struct is shared by extraction and rewrite. Extraction feeds the
    rewrite prompt rather than rendering, so a section that came back with no
    items is still usable input — rejecting it here aborted the entire optimize
    run with "structured extraction failed" on nothing worse than ensemble
    variance. The near-blank-render guard belongs in _variant."""
    r = ro._sanitize_struct(
        {"name": "A", "contact_line": "c", "sections": [{"heading": "S", "items": []}]}
    )
    assert r is not None
    assert r["sections"][0]["heading"] == "S"


def test_a_wholly_empty_struct_is_still_rejected():
    assert ro._sanitize_struct({"name": "", "contact_line": "", "sections": []}) is None


# --- the truthfulness gate must not reject a skill the candidate has ---------

_SRC = (
    "SKILLS\nPython, TypeScript, JavaScript, React, Next.js, Node.js, "
    "PostgreSQL, SQL, Docker, Git, Linux, REST APIs, Playwright"
)
_MASTER = ["python", "typescript", "react", "next.js", "node.js", "postgresql", "docker"]


@pytest.mark.parametrize("token", ["node", "node.js", "next", "next.js", "js", "python"])
def test_a_dotted_skill_defends_its_parts(token):
    """The token pattern includes ".", so "Node.js" produced only the token
    "node.js" — never "node". KNOWN_SKILLS lists plain "node", so the gate could
    not defend it and rejected the rewrite for inventing a skill printed on the
    candidate's own resume. Live, all three variants dropped on ['node'] and the
    optimizer produced nothing at all."""
    assert token in ro._allowed_tokens(_SRC, _MASTER)


def test_a_realistic_rewrite_passes_the_gate():
    allowed = ro._allowed_tokens(_SRC, _MASTER)
    variant = {
        "name": "A B", "contact_line": "Hyderabad, India | a@b.com",
        "sections": [{"heading": "SKILLS", "items": [{"head": "", "sub": "", "bullets": [
            "Frameworks: React, Next.js, Node.js",
            "Data & Tools: PostgreSQL, Docker, Git, Linux",
        ]}]}],
    }
    assert ro._fabricated_skills(variant, allowed) == []


def test_a_genuinely_invented_skill_is_still_caught():
    """The gate's whole purpose — relaxing the dotted-name case must not relax
    this one."""
    allowed = ro._allowed_tokens(_SRC, _MASTER)
    variant = {
        "name": "A", "contact_line": "Hyderabad, India",
        "sections": [{"heading": "SKILLS", "items": [{"head": "", "sub": "", "bullets": [
            "Kubernetes, AWS and Terraform at scale",
        ]}]}],
    }
    assert set(ro._fabricated_skills(variant, allowed)) >= {"aws", "kubernetes"}


def test_a_sanitized_struct_renders_to_a_real_document():
    r = ro._sanitize_struct({
        "name": "A B", "contact_line": "a@b.com",
        "sections": [{"heading": "SKILLS", "items": ["Python, React"]}],
    })
    tex = ro._render_latex(r)
    # The live failure rendered ~94 characters and was rejected downstream.
    assert len(tex) > 300
    assert "Python, React" in tex


# --- the rewrite must not be merged into an empty resume -----------------------

def _rewrite_response(bullet):
    import json
    return json.dumps({
        "resume": {"name": "A B", "contact_line": "a@b.com", "sections": [
            {"heading": "SKILLS", "items": [{"head": "", "sub": "", "bullets": [bullet]}]}]},
        "changes": ["reworded the skills line"],
    })


def test_rewrite_keeps_one_response_instead_of_merging_to_empty(monkeypatch):
    """chat_json_ensemble majority-votes every list item by exact content
    (llm._merge_lists). Extraction survives it — models copy facts verbatim, so
    the items are identical — but a REWRITE rewords each bullet, so no section is
    produced identically by two models and the merge drops all of them. Live,
    every strategy came back "rewrite returned no content" and the feature made
    nothing. _rewrite_struct must take whole un-merged responses and keep the
    first coherent one."""
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", lambda *a, **k: [
        _rewrite_response("Languages: Python, SQL"),
        _rewrite_response("Programming: Python and SQL"),
        _rewrite_response("Tech stack: Python, SQL, Git"),
    ])
    out = ro._rewrite_struct(
        {"name": "A B", "contact_line": "a@b.com", "sections": []}, "keywords", ["python", "sql"],
        ro._source_stems("Languages Python SQL Git programming tech stack"))
    assert out is not None, "a coherent rewrite existed and must be returned"
    struct = ro._sanitize_struct(out["resume"])
    assert struct and any(s["items"] for s in struct["sections"]), \
        "the rewritten content must survive — this is the bug"


def test_rewrite_returns_none_when_no_provider_answers(monkeypatch):
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", lambda *a, **k: [])
    assert ro._rewrite_struct(
        {"name": "A", "contact_line": "c", "sections": []}, "x", [], set()) is None


def test_rewrite_prefers_the_response_that_kept_the_most_content(monkeypatch):
    """A model sometimes returns section headings with the items dropped. Live, a
    keyword rewrite kept six skill bullets but emptied Experience/Projects/
    Education; the compiled PDF held ~196 chars and was rejected, while a fuller
    sibling response was thrown away. Pick the richest, not the first non-empty."""
    import json
    sparse = json.dumps({"resume": {"name": "A", "contact_line": "c", "sections": [
        {"heading": "SKILLS", "items": [{"head": "", "sub": "", "bullets": ["Python"]}]},
        {"heading": "EXPERIENCE", "items": []},
        {"heading": "PROJECTS", "items": []}]}, "changes": ["x"]})
    rich = json.dumps({"resume": {"name": "A", "contact_line": "c", "sections": [
        {"heading": "SKILLS", "items": [{"head": "", "sub": "", "bullets": ["Python, SQL"]}]},
        {"heading": "EXPERIENCE", "items": [{"head": "Eng", "sub": "2025", "bullets": ["Built X", "Shipped Y"]}]},
        {"heading": "PROJECTS", "items": [{"head": "Grindly", "sub": "", "bullets": ["Did Z"]}]}]}, "changes": ["y"]})
    # sparse first, so first-non-empty would wrongly win.
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", lambda *a, **k: [sparse, rich])
    out = ro._rewrite_struct(
        {"name": "A", "contact_line": "c", "sections": []}, "keywords", ["python", "sql"],
        ro._source_stems("Grindly 2025 Python SQL Eng built shipped"))
    struct = ro._sanitize_struct(out["resume"])
    kept = [s["heading"] for s in struct["sections"] if s["items"]]
    assert "EXPERIENCE" in kept and "PROJECTS" in kept, "must pick the fuller rewrite"


# --- the "resume of someone else" incident ------------------------------------
#
# Shipped to a live user: a variant scoring 82 whose Experience read "AI Engineer,
# XYZ Corp" and "Software Engineer, ABC Tech", whose Education read "MSc,
# University of Technology | 2020", whose Projects were four inventions, and whose
# header read "[phone redacted] | [email redacted]". Not one true employer, school,
# date, or contact detail. Three separate holes let it through, one per block below.

_REAL = """Sammeta Sakthi Mahendhar
(cid:132) +91 8096267553 | # mahendharsammeta21@gmail.com | (cid:239) mahendhar-sammeta | § mahisamm

EDUCATION
Anurag University
B.Tech in Artificial Intelligence and Machine Learning (CGPA: 7.45)   2023 - Present

EXPERIENCE
Piersoft Technologies
AI Intern
- Engineered a zero-budget AI office monitoring system bridging live CCTV feeds with biometric attendance data.
- Developed an interactive chatbot interface that locates employees and streams live video footage.

PROJECTS
SpaceVerse
- Architected a scalable MERN backend with JWT security for real-time astronomical simulations.
SmartRX
- Engineered an AI-powered prescription reader using Vision-Language Models and Tesseract OCR.
Grindly.in
- Developed a full-stack SaaS orchestrating autonomous AI agents that apply for internships.

SKILLS
Languages: Python, TypeScript, Java, SQL
Databases: PostgreSQL, MongoDB, Redis
"""


def _base():
    """What extraction returns for _REAL — note the redacted contact line, which is
    exactly what the model is shown and therefore what it copies back."""
    return {
        "name": "Sammeta Sakthi Mahendhar",
        "contact_line": "[phone redacted] | [email redacted] | mahendhar-sammeta | mahisamm",
        "sections": [
            {"heading": "Education", "items": [
                {"head": "B.Tech in Artificial Intelligence and Machine Learning",
                 "sub": "Anurag University", "bullets": ["CGPA: 7.45"]}]},
            {"heading": "Experience", "items": [
                {"head": "AI Intern", "sub": "Piersoft Technologies", "bullets": [
                    "Engineered a zero-budget AI office monitoring system bridging live CCTV feeds with biometric attendance data.",
                    "Developed an interactive chatbot interface that locates employees and streams live video footage."]}]},
            {"heading": "Projects", "items": [
                {"head": "SpaceVerse", "sub": "", "bullets": [
                    "Architected a scalable MERN backend with JWT security for real-time astronomical simulations."]},
                {"head": "SmartRX", "sub": "", "bullets": [
                    "Engineered an AI-powered prescription reader using Vision-Language Models and Tesseract OCR."]},
                {"head": "Grindly.in", "sub": "", "bullets": [
                    "Developed a full-stack SaaS orchestrating autonomous AI agents that apply for internships."]}]},
        ],
    }


# hole 0: the extraction collapsed, so the rewrite invented a resume from nothing

def _extract_response(n_items, tag=""):
    import json
    return json.dumps({"name": "Sammeta Sakthi Mahendhar", "contact_line": "a@b.com", "sections": [
        {"heading": "Projects", "items": [
            {"head": f"Project {tag}{i}", "sub": "", "bullets": ["Built a thing"]} for i in range(n_items)]}]})


def test_extraction_falls_back_when_the_ensemble_merge_keeps_nothing(monkeypatch):
    """chat_json_ensemble majority-votes each list item by exact content. Models
    don't agree byte-for-byte on section names or ordering, so on a real 3,778-char
    resume the merge returned 0 items while the individual responses held 12 and
    15. That empty struct is what the rewriter was then asked to "improve"."""
    calls = []

    def _ensemble(*a, **k):
        calls.append(1)
        # Two disjoint sets: nothing has majority support, so the merge keeps none.
        return [_extract_response(4, "A"), _extract_response(7, "B")]

    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", _ensemble)
    out = ro._extract_struct("a resume long enough to matter " * 20)
    assert ro._item_count(out) == 7, "must recover the richest un-merged response"
    assert len(calls) == 1, "a failed merge must not cost a second round of provider calls"


def test_extraction_keeps_the_merge_when_it_worked(monkeypatch):
    """Cross-model agreement is higher fidelity when it survives — the fallback is
    a repair, not a replacement."""
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", lambda *a, **k: [
        _extract_response(6), _extract_response(6), _extract_response(3)])
    assert ro._item_count(ro._extract_struct("text " * 100)) == 6


def test_an_empty_extraction_aborts_instead_of_being_rewritten(monkeypatch):
    """The load-bearing guard. Handed an empty resume, a model does not fail — it
    writes a plausible career and hands it back, and the result scores well because
    the scorer measures parseability, not truth. That is the whole incident."""
    monkeypatch.setattr(ro.latex_resume, "tectonic_available", lambda: True)
    monkeypatch.setattr(ro.resume_ai, "analyze", lambda t: {})
    monkeypatch.setattr(ro.resume_ai, "with_ats", lambda a, t, s: {"score": 76, "grade": "B"})
    monkeypatch.setattr(ro, "_extract_struct",
                        lambda text: {"name": "N", "contact_line": "c", "sections": []})

    def _never(*a, **k):
        raise AssertionError("a rewrite must never run on an empty base")

    monkeypatch.setattr(ro, "_rewrite_struct", _never)
    out = ro.generate_variants(_REAL, ["python"])
    assert out["aborted"] == "extraction_failed"
    assert out["variants"] == []


# hole 1: identity was taken from a PII-redacted prompt

def test_identity_is_read_from_the_resume_not_from_the_model():
    name, contact = ro._identity_from_source(_REAL)
    assert name == "Sammeta Sakthi Mahendhar"
    assert "mahendharsammeta21@gmail.com" in contact
    assert "8096267553" in contact


def test_icon_font_debris_is_stripped_from_the_contact_line():
    """A PDF text layer leaves FontAwesome glyphs with no Unicode mapping. Printed
    back into a new PDF they render as mojibake beside the phone number."""
    _, contact = ro._identity_from_source(_REAL)
    for junk in ("cid:", "#", "§"):
        assert junk not in contact
    assert "mahendhar-sammeta" in contact, "real handles must survive the cleanup"


def test_the_redaction_placeholder_never_reaches_the_document():
    """The bug, end to end: without the stamp the compiled resume tells an employer
    to contact the candidate at "[email redacted]"."""
    struct = _base()
    ro._stamp_identity(struct, ro._identity_from_source(_REAL))
    tex = ro._render_latex(struct)
    assert "redacted" not in tex
    assert "mahendharsammeta21@gmail.com" in tex


def test_a_document_title_is_not_mistaken_for_a_name():
    """"Curriculum Vitae" on its own line passes every other test for a name."""
    name, _ = ro._identity_from_source("Curriculum Vitae\nPriya Sharma\npriya@example.com")
    assert name == "Priya Sharma"


def test_a_redaction_marker_is_scrubbed_when_no_real_contact_was_found():
    """Belt and braces on the header: if nothing local was recoverable, an empty
    contact line beats one that tells an employer to write to [email redacted]."""
    struct = {"name": "N", "contact_line": "[phone redacted] | [email redacted]", "sections": []}
    ro._stamp_identity(struct, ("", ""))
    assert "redacted" not in struct["contact_line"]


def test_the_rewrite_prompt_is_never_given_the_real_contact_details(monkeypatch):
    """Redaction at the LLM boundary is a runtime setting, not a guarantee. The
    struct that gets serialised into the prompt must not carry PII in the first
    place — identity is stamped onto the VARIANT, after the model has answered."""
    seen = {}

    def _capture(prompt, **k):
        seen["prompt"] = prompt
        return []

    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", _capture)
    monkeypatch.setattr(ro.latex_resume, "tectonic_available", lambda: True)
    monkeypatch.setattr(ro.resume_ai, "analyze", lambda t: {})
    monkeypatch.setattr(ro.resume_ai, "with_ats", lambda a, t, s: {"score": 70, "grade": "C"})
    monkeypatch.setattr(ro, "_extract_struct", lambda text: {
        "name": "N", "contact_line": "[phone redacted]", "sections": [
            {"heading": "Projects", "items": [
                {"head": f"P{i}", "sub": "", "bullets": ["did a thing"]} for i in range(4)]}]})
    ro.generate_variants(_REAL, ["python"])
    assert "8096267553" not in seen.get("prompt", "")
    assert "mahendharsammeta21@gmail.com" not in seen.get("prompt", "")


@pytest.mark.parametrize("header,expected_name,expected_in_contact", [
    # The shapes other people's resumes actually arrive in. Only one of these was
    # ever tested against a real document — the owner's — so each is a guess until
    # it is pinned here.
    ("Priya Sharma\npriya.sharma@gmail.com | +91 98765 43210 | Bengaluru",
     "Priya Sharma", "priya.sharma@gmail.com"),
    ("RAHUL KUMAR VERMA\n9876543210 | rahul@x.io", "RAHUL KUMAR VERMA", "rahul@x.io"),
    ("Neha Gupta\nlinkedin.com/in/nehagupta | github.com/neha | neha@x.com",
     "Neha Gupta", "github.com/neha"),
    ("amit@x.com | 9999999999 | Hyderabad, India\nAmit Roy", "Amit Roy", "Hyderabad, India"),
    ("(cid:12) Vikram S\nAddress: 12/3, MG Road, Pune 411001\nvikram@x.com | 8888888888",
     "Vikram S", "vikram@x.com"),
])
def test_headers_from_other_peoples_resumes(header, expected_name, expected_in_contact):
    name, contact = ro._identity_from_source(header)
    assert name == expected_name
    assert expected_in_contact in contact


@pytest.mark.parametrize("resume,wanted", [
    ("Sneha Rao\nSoftware Engineer\n\nSUMMARY\nEmail sneha@x.com at the very bottom", "sneha@x.com"),
    ("Ravi N\nReach me any time on 9876543210 for a quick chat about roles", "9876543210"),
])
def test_a_prose_line_that_merely_contains_contact_details_is_not_a_header(resume, wanted):
    """Taking the whole line printed "Email sneha@x.com at the very bottom" across
    the top of the rebuilt resume. Pull the detail out; leave the sentence."""
    _, contact = ro._identity_from_source(resume)
    assert contact == wanted


_THIN = {"name": "Ankit Jain", "contact_line": "c", "sections": [
    {"heading": "Education", "items": [
        {"head": "B.Sc Computer Science", "sub": "Delhi University | 2026", "bullets": []}]},
    {"heading": "Projects", "items": [
        {"head": "Todo App", "sub": "", "bullets": ["Built with React and Firebase"]}]}]}


def _stub_scoring(monkeypatch):
    monkeypatch.setattr(ro.latex_resume, "tectonic_available", lambda: True)
    monkeypatch.setattr(ro.resume_ai, "analyze", lambda t: {})
    monkeypatch.setattr(ro.resume_ai, "with_ats", lambda a, t, s: {"score": 60, "grade": "D"})
    monkeypatch.setattr(ro, "_rewrite_struct", lambda *a, **k: None)


def test_a_thin_but_real_resume_is_not_refused(monkeypatch):
    """Two items off a 4,000-character resume means extraction failed. Two off a
    600-character fresher resume IS the resume — refusing it would deny the feature
    to the users who most need a rebuild. Invention stays blocked either way:
    provenance drops any item with no ancestor."""
    short = ("Ankit Jain\nankit@x.com | 9000000000\n\nEDUCATION\nB.Sc Computer Science, "
             "Delhi University, 2026\n\nPROJECTS\nTodo App - built with React and Firebase, "
             "with Google sign-in and offline sync for a college assignment\n"
             "SKILLS\nReact, Firebase, JavaScript, HTML, CSS, Git, Python, SQL\n")
    assert 200 < len(short) < 800
    _stub_scoring(monkeypatch)
    monkeypatch.setattr(ro, "_extract_struct", lambda text: _THIN)
    assert ro.generate_variants(short, ["react"])["aborted"] is None


def test_the_same_thin_extraction_off_a_long_resume_still_aborts(monkeypatch):
    """Same two items, four thousand characters of source: that is a failed
    extraction, and rewriting from it is how a career gets invented."""
    _stub_scoring(monkeypatch)
    monkeypatch.setattr(ro, "_extract_struct", lambda text: _THIN)
    assert ro.generate_variants("word " * 900, ["react"])["aborted"] == "extraction_failed"


def test_a_profile_fallback_is_used_when_the_resume_header_is_unreadable():
    name, contact = ro._identity_from_source("no header here at all", "+91 90000 00000 | a@b.com")
    assert not name
    assert "a@b.com" in contact


# hole 2: the truthfulness gate only ever looked at skills

def test_an_invented_employer_is_dropped():
    stems = ro._source_stems(_REAL)
    variant = {"name": "X", "contact_line": "c", "sections": [{"heading": "Experience", "items": [
        {"head": "AI Engineer", "sub": "XYZ Corp | Jan 2022 - Present",
         "bullets": ["Developed ML models for a document processing pipeline"]}]}]}
    out, dropped = ro._ground_struct(variant, stems, _base())
    assert out["sections"] == []
    assert dropped and "Experience" in dropped[0]


def test_an_invented_degree_and_year_are_dropped():
    bad = ro._ungrounded_tokens(
        {"head": "Master of Science in Computer Science",
         "sub": "University of Technology | 2020", "bullets": []},
        ro._source_stems(_REAL),
    )
    assert "2020" in bad, "a year the resume never mentions is a fabricated claim"


def test_a_fabricated_metric_is_caught():
    """'Achieved 30 FPS on edge devices with TensorRT' — the number is the lie."""
    bad = ro._ungrounded_tokens(
        {"head": "SmartRX", "sub": "", "bullets": ["Achieved 30 FPS on edge devices"]},
        ro._source_stems(_REAL),
    )
    assert "30" in bad


def test_a_real_number_from_the_resume_is_not_flagged():
    bad = ro._ungrounded_tokens(
        {"head": "B.Tech in AI and ML", "sub": "Anurag University | 2023", "bullets": ["CGPA 7.45"]},
        ro._source_stems(_REAL),
    )
    assert bad == []


def test_ordinary_rewording_is_not_mistaken_for_invention():
    """'Engineered' -> 'Engineer' must stay legal, or the gate eats every rewrite."""
    stems = ro._source_stems(_REAL)
    assert ro._is_grounded("Engineer", stems)
    assert ro._is_grounded("Technologies", stems)


# hole 3: provenance — a rewrite may reword an entry, never add one

def test_an_invented_project_whose_words_all_exist_is_still_dropped():
    """Every word of "Scalable Chatbot Backend" appears somewhere on the real
    resume, so token grounding alone clears it. Provenance is what kills it: no
    entry on the master resembles it."""
    stems = ro._source_stems(_REAL)
    item = {"head": "Scalable Chatbot Backend", "sub": "", "bullets": [
        "Designed a Node.js service with PostgreSQL for session storage"]}
    assert ro._ungrounded_tokens(item, stems) == [], "premise: the token gate passes it"
    out, dropped = ro._ground_struct(
        {"name": "X", "contact_line": "c",
         "sections": [{"heading": "Projects", "items": [item]}]},
        stems, _base(),
    )
    assert out["sections"] == []
    assert "no matching entry" in dropped[0]


def test_a_reworded_real_entry_survives():
    stems = ro._source_stems(_REAL)
    out, dropped = ro._ground_struct(
        {"name": "X", "contact_line": "c", "sections": [{"heading": "Experience", "items": [
            {"head": "AI Intern", "sub": "Piersoft Technologies", "bullets": [
                "Built an AI office monitoring system bridging live CCTV feeds with biometric attendance data",
                "Shipped a chatbot interface that locates employees and streams their video footage"]}]}]},
        stems, _base(),
    )
    assert dropped == []
    assert out["sections"][0]["items"], "a genuine rewrite must not be gated"


@pytest.mark.parametrize("group", ["Frontend", "Backend & APIs", "Testing", "AI/ML & Vision"])
def test_a_skills_group_label_is_not_treated_as_a_claim(group):
    """A grouping label is the rewrite's own categorisation, not something the
    candidate asserts. Checking them cost a live run all three variants: eight
    labels were deleted as "not in your resume", leaving near-empty documents that
    scored 20-35 against an 88 master."""
    out, dropped = ro._ground_struct(
        {"name": "X", "contact_line": "c", "sections": [{"heading": "Technical Skills", "items": [
            {"head": group, "sub": "", "bullets": ["PostgreSQL", "MongoDB", "Redis"]}]}]},
        ro._source_stems(_REAL), _base(),
    )
    assert dropped == []
    assert out["sections"][0]["items"], "regrouping skills is the point of the feature"


def test_a_version_number_inside_a_tool_name_is_not_a_metric():
    """"YOLOv8" was read as a bare "8" and rejected as an invented number."""
    stems = ro._source_stems(_REAL + "\nYOLOv8, Three.js, S3")
    assert ro._ungrounded_tokens(
        {"head": "SmartRX", "sub": "", "bullets": ["Deployed a YOLOv8 pipeline on S3"]}, stems) == []


@pytest.mark.parametrize("source,written", [
    ("managed 50k+ tokens", "managed 50,000+ tokens"),   # same fact, reformatted
    ("managed 50k+ tokens", "managed 50k tokens"),
    ("an immersive 3D/VR platform", "a 3D platform"),     # "3" is not a claim
    ("1st place at the expo", "1st place"),
    ("CGPA: 7.45", "CGPA 7.45"),
])
def test_a_real_number_survives_being_rewritten(source, written):
    """Three real entries were deleted as invented in a live run over exactly this:
    "50k+" read as a bare "50", "3D/VR" as a bare "3", "1st" as a bare "1"."""
    assert ro._ungrounded_tokens(
        {"head": "", "sub": "", "bullets": [written]}, ro._source_stems(source)) == []


def test_an_inflated_number_is_still_caught():
    """The gate must not become decorative — 50k in, 500k out is a fabrication."""
    bad = ro._ungrounded_tokens(
        {"head": "", "sub": "", "bullets": ["managed 500k tokens"]},
        ro._source_stems("managed 50k+ tokens"))
    assert bad, "an invented quantity must not pass"


@pytest.mark.parametrize("score", [87, 85, 82])
def test_a_loss_inside_the_scorer_noise_is_not_treated_as_a_worse_resume(score):
    """The same master re-scored 70, 76 and 88 across three runs. Discarding an 85
    against an 88 throws away good work over a coin flip."""
    assert score >= 88 - ro._SCORE_NOISE


@pytest.mark.parametrize("score", [81, 60, 35])
def test_a_materially_worse_rewrite_is_still_discarded(score):
    assert score < 88 - ro._SCORE_NOISE


def test_a_near_tie_is_kept_and_labelled(monkeypatch):
    variant, reason = _run_variant(monkeypatch, 85, baseline=88)
    assert variant is not None
    assert variant["beats_baseline"] is False
    assert "level" in reason.lower()


def test_a_real_loss_is_still_discarded(monkeypatch):
    variant, reason = _run_variant(monkeypatch, 60, baseline=88)
    assert variant is None
    assert "discarded" in reason


def test_selection_prefers_the_faithful_rewrite_over_the_richer_invented_one(monkeypatch):
    """The core defect. Candidates were weighed by raw content, so a model that
    ignored the input and emitted a longer generic resume beat a faithful sibling
    every time — which is precisely how "XYZ Corp" reached a user's dashboard."""
    import json
    invented = json.dumps({"resume": {"name": "N", "contact_line": "c", "sections": [
        {"heading": "Experience", "items": [
            {"head": "AI Engineer", "sub": "XYZ Corp | Jan 2022 - Present",
             "bullets": ["Developed ML models", "Optimized backend services", "Integrated APIs"]},
            {"head": "Software Engineer", "sub": "ABC Tech | Jun 2020 - Dec 2021",
             "bullets": ["Built frontends", "Implemented caching", "Automated testing"]}]},
        {"heading": "Education", "items": [
            {"head": "Master of Science in Computer Science", "sub": "University of Technology | 2020",
             "bullets": ["Specialized in Machine Learning"]}]}]}, "changes": ["restructured"]})
    faithful = json.dumps({"resume": {"name": "N", "contact_line": "c", "sections": [
        {"heading": "Experience", "items": [
            {"head": "AI Intern", "sub": "Piersoft Technologies",
             "bullets": ["Engineered an AI office monitoring system bridging live CCTV feeds with biometric attendance data"]}]},
        {"heading": "Projects", "items": [
            {"head": "SmartRX", "sub": "", "bullets": [
                "Engineered an AI-powered prescription reader using Vision-Language Models and Tesseract OCR"]}]}]},
        "changes": ["tightened the bullets"]})
    # Invented first AND longer: it wins on every metric except the truth.
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", lambda *a, **k: [invented, faithful])
    out = ro._rewrite_struct(_base(), "instruction", ["python"], ro._source_stems(_REAL))
    blob = str(out["resume"])
    assert "XYZ Corp" not in blob and "University of Technology" not in blob
    assert "Piersoft" in blob, "the honest rewrite must be the one selected"


# --- render: a skills group is a list of words, not a column of achievements ---

def test_a_skills_group_renders_as_a_line_not_a_column_of_words():
    """One \\item per skill turned seven groups into thirty bullets and pushed a
    one-page intern resume onto two — the layout a user called unusable."""
    tex = ro._render_latex({"name": "A B", "contact_line": "a@b.com", "sections": [
        {"heading": "Technical Skills", "items": [
            {"head": "Languages & Frameworks", "sub": "", "bullets": ["Python", "TypeScript", "Java", "SQL"]},
            {"head": "Databases", "sub": "", "bullets": ["MongoDB", "Redis", "PostgreSQL"]}]}]})
    assert "\\item Python" not in tex
    assert "Python, TypeScript, Java, SQL" in tex
    assert "\\textbf{Languages \\& Frameworks:}" in tex


def test_every_skills_group_renders_the_same_way():
    """One group as a line and the next as a bulleted column, inside one section,
    looks broken — and that mixture shipped."""
    tex = ro._render_latex({"name": "A B", "contact_line": "c", "sections": [
        {"heading": "Technical Skills", "items": [
            {"head": "Programming", "sub": "", "bullets": ["Python", "TypeScript"]},
            {"head": "AI/ML & Vision", "sub": "", "bullets": [
                "Machine Learning, Deep Learning, Computer Vision", "YOLOv8, Tesseract"]}]}]})
    assert "\\begin{itemize}" not in tex, "no group may fall back to bullets"
    assert "Machine Learning, Deep Learning, Computer Vision; YOLOv8, Tesseract" in tex


def test_a_split_entry_is_not_read_as_invented():
    """Splitting an entry is explicitly allowed. "Certifications: ServiceNow
    Fundamentals, Python Bootcamp, Data Mining" split one-per-certificate leaves
    each item two words long — real content a flat three-word threshold deletes."""
    base = {"name": "N", "contact_line": "c", "sections": [{"heading": "Certifications", "items": [
        {"head": "Certifications", "sub": "", "bullets": [
            "ServiceNow Fundamentals, Python Bootcamp (Udemy), Data Mining (Infosys)"]}]}]}
    out, dropped = ro._ground_struct(
        {"name": "N", "contact_line": "c", "sections": [{"heading": "Certifications", "items": [
            {"head": "ServiceNow Fundamentals", "sub": "", "bullets": []},
            {"head": "Python Bootcamp", "sub": "", "bullets": ["Udemy"]}]}]},
        ro._source_stems("ServiceNow Fundamentals, Python Bootcamp (Udemy), Data Mining (Infosys)"),
        base,
    )
    assert dropped == []
    assert len(out["sections"][0]["items"]) == 2


def test_a_two_word_invention_is_still_dropped():
    """The short-item allowance must not become a hole: matching ALL of two words
    is still a real match, and "Kubernetes Migration" matches nothing."""
    base = {"name": "N", "contact_line": "c", "sections": [{"heading": "Projects", "items": [
        {"head": "SmartRX", "sub": "", "bullets": ["Prescription reader with Tesseract OCR"]}]}]}
    out, dropped = ro._ground_struct(
        {"name": "N", "contact_line": "c", "sections": [{"heading": "Projects", "items": [
            {"head": "Kubernetes Migration", "sub": "", "bullets": []}]}]},
        ro._source_stems("SmartRX prescription reader with Tesseract OCR kubernetes migration"),
        base,
    )
    assert out["sections"] == []
    assert "no matching entry" in dropped[0]


def test_a_prose_skills_section_stays_bulleted_rather_than_becoming_a_paragraph():
    """Compaction assumes keyword lists. Joining full sentences with "; " makes a
    wall of text — worse than the bullets it replaced."""
    prose = ("Utilized programming languages including Python, TypeScript and Java, "
             "as well as SQL for database management across several production systems")
    tex = ro._render_latex({"name": "A B", "contact_line": "c", "sections": [
        {"heading": "Technical Skills", "items": [
            {"head": "", "sub": "", "bullets": [prose, "Employed frameworks such as Next.js and React"]}]}]})
    assert "\\begin{itemize}" in tex


def test_a_long_title_and_meta_stack_instead_of_colliding():
    """\\hfill reads well for "AI Intern .... Piersoft | 2023" and turns into a
    run-together mess once the pair wraps."""
    tex = ro._render_latex({"name": "A B", "contact_line": "c", "sections": [
        {"heading": "Experience", "items": [
            {"head": "AI Tech Lead (Summer of AI 2025)",
             "sub": "Viswam.AI - IIIT Hyderabad | Jun 2025 - Aug 2025 | Hyderabad, India",
             "bullets": ["Curated a Telugu LLM dataset"]}]}]})
    assert "\\hfill" not in tex
    assert "\\textbf{AI Tech Lead (Summer of AI 2025)}\\par" in tex


def test_a_short_title_and_meta_still_share_a_line():
    tex = ro._render_latex({"name": "A B", "contact_line": "c", "sections": [
        {"heading": "Experience", "items": [
            {"head": "AI Intern", "sub": "Piersoft | 2023", "bullets": ["Built a thing"]}]}]})
    assert "\\textbf{AI Intern} \\hfill Piersoft | 2023\\par" in tex


def test_experience_bullets_still_render_as_bullets():
    """The compaction is scoped to skills — achievements stay scannable."""
    tex = ro._render_latex({"name": "A B", "contact_line": "c", "sections": [
        {"heading": "Experience", "items": [
            {"head": "AI Intern", "sub": "Piersoft", "bullets": [
                "Engineered a zero-budget AI office monitoring system",
                "Developed an interactive chatbot interface"]}]}]})
    assert "\\begin{itemize}" in tex
    assert "\\item Engineered a zero-budget AI office monitoring system" in tex


# --- a worse resume is never offered ------------------------------------------

class _FakeCompile:
    def __init__(self, pages=1):
        self.ok, self.pages, self.overfull = True, pages, 0


def _stub_pipeline(monkeypatch, score):
    """Everything downstream of the rewrite, faked: compile, parse, re-score."""
    grounded = {"name": "N", "contact_line": "c", "sections": [
        {"heading": "Education", "items": [
            {"head": "B.Tech in Artificial Intelligence and Machine Learning",
             "sub": "Anurag University", "bullets": ["CGPA 7.45"]}]},
        {"heading": "Experience", "items": [
            {"head": "AI Intern", "sub": "Piersoft Technologies",
             "bullets": ["Engineered an AI office monitoring system"]}]},
        {"heading": "Projects", "items": [
            {"head": "SmartRX", "sub": "", "bullets": ["Engineered a prescription reader"]},
            {"head": "Grindly.in", "sub": "", "bullets": ["Developed a full-stack SaaS"]}]}]}
    monkeypatch.setattr(ro, "_rewrite_struct",
                        lambda *a, **k: {"resume": grounded, "changes": ["tightened"], "dropped": []})
    monkeypatch.setattr(ro.latex_resume, "unsafe_commands", lambda tex: False)

    def _compile(tex, path):
        with open(path, "wb") as f:
            f.write(b"%PDF-1.4\n")
        return _FakeCompile()

    monkeypatch.setattr(ro.latex_resume, "compile_report", _compile)
    monkeypatch.setattr(ro.resume_parse, "extract_text", lambda p: "readable text " * 40)
    monkeypatch.setattr(ro.resume_ai, "analyze", lambda t: {})
    monkeypatch.setattr(ro.resume_ai, "with_ats", lambda a, t, s: {"score": score, "grade": "B"})


def _run_variant(monkeypatch, score, baseline=76):
    _stub_pipeline(monkeypatch, score)
    return ro._one_variant(
        "ATS-clean", "instruction", _base(), ro._allowed_tokens(_REAL, []), [], baseline,
        ro._identity_from_source(_REAL), ro._source_stems(_REAL),
    )


def test_a_variant_that_scores_lower_than_the_master_is_never_offered(monkeypatch):
    """A 35/F rebuild was displayed beside the user's own 76, behind the same
    "Use as my resume" button. Showing it was a deliberate choice and a wrong one."""
    variant, reason = _run_variant(monkeypatch, 35)
    assert variant is None
    assert "discarded" in reason and "35" in reason and "76" in reason


def test_a_tie_is_still_offered(monkeypatch):
    """Same score on a single-column template is a real win for a parser."""
    variant, reason = _run_variant(monkeypatch, 76)
    assert variant is not None
    assert variant["beats_baseline"] is False
    assert "level" in reason.lower()


def test_a_winner_is_offered(monkeypatch):
    variant, _ = _run_variant(monkeypatch, 82)
    assert variant and variant["score"] == 82 and variant["beats_baseline"] is True


def test_a_wholesale_hallucination_is_rejected_as_drift(monkeypatch):
    """Grounding removes invented items one at a time; a response that invented
    EVERYTHING therefore arrives here having kept almost nothing of the master."""
    _stub_pipeline(monkeypatch, 90)
    monkeypatch.setattr(ro, "_rewrite_struct", lambda *a, **k: {
        "resume": {"name": "N", "contact_line": "c", "sections": [
            {"heading": "Technical Skills", "items": [
                {"head": "Languages", "sub": "", "bullets": ["Python", "SQL"]}]}]},
        "changes": ["rewrote"],
        "dropped": ["Experience/AI Engineer: not in your resume (Corp)"]})
    variant, reason = ro._one_variant(
        "ATS-clean", "instruction", _base(), ro._allowed_tokens(_REAL, []), [], 76,
        ro._identity_from_source(_REAL), ro._source_stems(_REAL),
    )
    assert variant is None
    assert "drifted" in reason
