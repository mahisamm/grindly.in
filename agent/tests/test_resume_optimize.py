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


def test_a_struct_with_no_usable_items_is_rejected():
    """Rendering it produces a near-blank page, which is worse than saying
    nothing was produced."""
    assert ro._sanitize_struct(
        {"name": "A", "contact_line": "c", "sections": [{"heading": "S", "items": []}]}
    ) is None
    assert ro._sanitize_struct({"name": "", "contact_line": "", "sections": []}) is None


def test_a_sanitized_struct_renders_to_a_real_document():
    r = ro._sanitize_struct({
        "name": "A B", "contact_line": "a@b.com",
        "sections": [{"heading": "SKILLS", "items": ["Python, React"]}],
    })
    tex = ro._render_latex(r)
    # The live failure rendered ~94 characters and was rejected downstream.
    assert len(tex) > 300
    assert "Python, React" in tex
