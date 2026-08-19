"""The .docx and plain-text writers.

The assertions that matter are all about what a PARSER gets, not about what the
document looks like — which is the same standard the PDF renderer is held to in
test_render.py. A .docx that looks right in Word and reads as one run-on line to
an extractor has failed at the only job it has.
"""
from __future__ import annotations

import io

import pytest

import render_docx

STRUCT = {
    "name": "Priya Sharma",
    "contact_line": "priya@example.com | +91 98765 43210 | Bengaluru | github.com/priya-r",
    "sections": [
        {
            "heading": "Experience",
            "items": [
                {
                    "head": "Backend Engineer",
                    "sub": "Freshworks, Jan 2024 - Present",
                    "bullets": [
                        "Cut import time from 40 minutes to 6.",
                        "Led the migration of 14 services to a shared auth library.",
                    ],
                }
            ],
        },
        {
            "heading": "Technical Skills",
            "items": [{"head": "Languages", "sub": "", "bullets": ["Python", "SQL", "Java"]}],
        },
    ],
}


def _paragraph_texts(data: bytes) -> list[str]:
    import docx

    return [p.text for p in docx.Document(io.BytesIO(data)).paragraphs]


def test_docx_is_a_real_openable_document():
    data = render_docx.build_docx(STRUCT)
    # A .docx is a zip. If this is not "PK", Word shows "the file is corrupt"
    # and the user concludes their resume was destroyed.
    assert data[:2] == b"PK"
    assert len(data) > 5000


def test_every_fact_survives_being_read_back():
    texts = " ".join(_paragraph_texts(render_docx.build_docx(STRUCT)))
    for fact in [
        "Priya Sharma",
        "priya@example.com",
        "Bengaluru",
        "Backend Engineer",
        "Freshworks",
        "Jan 2024",
        "40 minutes to 6",
        "14 services",
    ]:
        assert fact in texts, f"{fact!r} did not survive into the .docx"


def test_each_bullet_is_its_own_paragraph():
    """The property a parser depends on.

    Two bullets merged into one paragraph read as a single sentence with a
    full stop in the middle, and every "one bullet, one achievement" heuristic
    downstream sees half as much evidence.
    """
    paragraphs = _paragraph_texts(render_docx.build_docx(STRUCT))
    assert "Cut import time from 40 minutes to 6." in paragraphs
    assert "Led the migration of 14 services to a shared auth library." in paragraphs


def test_dates_stay_on_the_same_line_as_their_employer():
    """The docx equivalent of the PDF's inline-dates invariant.

    Right-aligning a date is what a good-looking resume does, and it is what
    puts the date five lines away from its own job title in the extracted text.
    Here they share one paragraph, so they cannot be separated.
    """
    paragraphs = _paragraph_texts(render_docx.build_docx(STRUCT))
    line = next(p for p in paragraphs if "Freshworks" in p)
    assert "Jan 2024" in line


def test_skills_render_as_one_line_not_as_bullets():
    """How a skills block is written, and how a keyword search reads it."""
    paragraphs = _paragraph_texts(render_docx.build_docx(STRUCT))
    assert any("Languages: Python, SQL, Java" == p for p in paragraphs)
    assert "Python" not in [p.strip() for p in paragraphs]


def test_no_tables_anywhere():
    """A table is the two-column layout readiness.py exists to warn about.

    Word's own HTML import produces them, which is why this writer builds the
    document directly instead of reusing the PDF's markup.
    """
    import docx

    doc = docx.Document(io.BytesIO(render_docx.build_docx(STRUCT)))
    assert len(doc.tables) == 0


def test_control_characters_do_not_produce_an_unopenable_file():
    """python-docx will write a NUL straight into the XML, and Word then refuses
    the file — which the user reads as "Grindly corrupted my resume"."""
    hostile = {
        "name": "Priya\x00 Sharma",
        "contact_line": "a@b.com\x0b",
        "sections": [
            {
                "heading": "Experience\x07",
                "items": [{"head": "Engineer", "sub": "", "bullets": ["Did\x01 a thing"]}],
            }
        ],
    }
    texts = " ".join(_paragraph_texts(render_docx.build_docx(hostile)))
    assert "\x00" not in texts
    assert "Priya Sharma" in texts
    assert "Did a thing" in texts


def test_empty_structure_still_produces_a_file():
    """No content is a caller's problem to refuse, not a reason to raise here."""
    data = render_docx.build_docx({"name": "", "contact_line": "", "sections": []})
    assert data[:2] == b"PK"


# ---------------------------------------------------------------------------
# plain text
# ---------------------------------------------------------------------------

def test_text_uses_a_real_bullet_character():
    """A hyphen reads as a mid-sentence dash to some parsers, which is how a
    bullet list becomes one long run-on line in an application form."""
    text = render_docx.build_text(STRUCT)
    assert "• Cut import time" in text


def test_text_keeps_the_title_and_the_dates_together():
    text = render_docx.build_text(STRUCT)
    line = next(l for l in text.splitlines() if "Freshworks" in l)
    assert "Backend Engineer" in line and "Jan 2024" in line


def test_text_has_no_trailing_whitespace_or_double_blanks():
    """It is going into a form field, where both survive and look like a mistake."""
    text = render_docx.build_text(STRUCT)
    lines = text.splitlines()
    assert all(line == line.rstrip() for line in lines)
    assert "\n\n\n" not in text
    assert text.endswith("\n")


def test_text_contains_every_fact():
    text = render_docx.build_text(STRUCT)
    for fact in ["Priya Sharma", "priya@example.com", "Freshworks", "Python, SQL, Java"]:
        assert fact in text


@pytest.mark.parametrize("builder", [render_docx.build_docx, render_docx.build_text])
def test_missing_keys_do_not_raise(builder):
    """The struct arrives from a browser through the editor. A missing key must
    be an empty field, not a KeyError on the far side of a subprocess."""
    builder({"sections": [{"items": [{"head": "Engineer"}]}]})
