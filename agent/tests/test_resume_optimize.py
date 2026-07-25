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
        {"name": "A B", "contact_line": "a@b.com", "sections": []}, "keywords", ["python", "sql"])
    assert out is not None, "a coherent rewrite existed and must be returned"
    struct = ro._sanitize_struct(out["resume"])
    assert struct and any(s["items"] for s in struct["sections"]), \
        "the rewritten content must survive — this is the bug"


def test_rewrite_returns_none_when_no_provider_answers(monkeypatch):
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", lambda *a, **k: [])
    assert ro._rewrite_struct({"name": "A", "contact_line": "c", "sections": []}, "x", []) is None
