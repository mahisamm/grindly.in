"""The same resume, as .docx and as plain text.

WHY THIS EXISTS AT ALL

A PDF is the right thing to send a human and the wrong thing to paste into a
form. Two things happen to every applicant that the PDF cannot help with:

  * A large share of Indian portals — campus placement systems especially —
    accept .doc/.docx and nothing else. "Upload your resume (DOC/DOCX only)" is
    a wall the best-scoring PDF in the world does not get through.
  * Every application form has a box that wants the text, and pasting from a PDF
    reader produces the extraction artefacts this whole product exists to
    measure. If we can print a clean text layer we can hand it over directly.

WHAT IT DOES NOT DO

It does not try to reproduce the PDF's typography. The .docx is a plain,
single-column, one-typeface document — which is not a compromise, it is the
same reasoning as render_pdf.py taken to a format we control less. Word will
re-flow this on whatever machine opens it, so anything clever about spacing is a
guess about someone else's default template. What survives is the structure a
parser reads: real headings, real paragraphs, real bullet characters.

Deliberately NOT reusing the PDF's HTML: Word's HTML import produces tables and
absolutely-positioned spans, which is precisely the two-column-lookalike layout
readiness.py exists to warn people about.
"""
from __future__ import annotations

import io
import re

# The one structural constant shared with render_pdf: what a skills-style
# section looks like. A skills block is written as "Head: a, b, c" rather than
# as bullets, because that is how it is read and how a keyword search matches it.
_SKILLS_RE = re.compile(r"\b(skills?|technolog|tools?|languages?|competenc)", re.I)

# Points. Deliberately conservative — a resume printed by a recruiter's assistant
# on a shared office printer is the target, not a screen.
_BODY_PT = 10.5
_NAME_PT = 24
_HEADING_PT = 11.5

_FONT = "Calibri"
"""Calibri, not the PDF's Liberation Sans.

The PDF is rendered by our Chromium in a container we control, so it uses a
metric-compatible Arial clone that is installed there. A .docx is opened on
someone else's machine and any font we name that they do not have is silently
substituted — so the only safe choice is one that ships with Word everywhere.
"""


def _clean(value: object) -> str:
    """One total function for text on its way into a document.

    Control characters and the private-use glyphs that some PDF extractors emit
    for ligatures are removed rather than escaped: python-docx will happily
    write a NUL into the XML and produce a file Word refuses to open, which
    presents to the user as "your resume is corrupt".
    """
    text = "" if value is None else str(value)
    text = text.replace("\r", " ").replace("\n", " ")
    out = []
    for ch in text:
        code = ord(ch)
        if code < 0x20 and ch != "\t":
            continue
        if 0xE000 <= code <= 0xF8FF:  # private use area
            continue
        out.append(ch)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def build_docx(struct: dict) -> bytes:
    """Render the resume structure to .docx bytes.

    Takes the same struct render_pdf.build_html does, so there is exactly one
    document model in this product and a change to the editor reaches both
    outputs at once.
    """
    from docx import Document
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.shared import Pt

    doc = Document()

    # One margin set, applied to every section Word created for us.
    for section in doc.sections:
        section.top_margin = Pt(36)
        section.bottom_margin = Pt(36)
        section.left_margin = Pt(45)
        section.right_margin = Pt(45)

    normal = doc.styles["Normal"]
    normal.font.name = _FONT
    normal.font.size = Pt(_BODY_PT)
    # Word ignores the style's font for East Asian text unless told twice; a
    # resume with a single CJK character otherwise switches typeface mid-line.
    normal.element.rPr.rFonts.set(
        "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}eastAsia", _FONT
    )
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = 1.08

    name = _clean(struct.get("name"))
    if name:
        para = doc.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = para.add_run(name)
        run.bold = True
        run.font.name = "Times New Roman"
        run.font.size = Pt(_NAME_PT)
        para.paragraph_format.space_after = Pt(2)

    contact = _clean(struct.get("contact_line"))
    if contact:
        para = doc.add_paragraph()
        para.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = para.add_run(contact)
        run.font.size = Pt(_BODY_PT - 0.5)
        para.paragraph_format.space_after = Pt(10)

    for section in struct.get("sections") or []:
        heading = _clean(section.get("heading"))
        is_skills = bool(_SKILLS_RE.search(heading))

        if heading:
            para = doc.add_paragraph()
            run = para.add_run(heading.upper())
            run.bold = True
            run.font.size = Pt(_HEADING_PT)
            para.paragraph_format.space_before = Pt(10)
            para.paragraph_format.space_after = Pt(3)
            # A bottom border on the heading paragraph, which is how Word draws
            # a rule. Not a table, not a shape: both are structures a parser has
            # to walk around, and one of them is the two-column lookalike that
            # readiness.py warns about.
            _underline(para)

        for item in section.get("items") or []:
            head = _clean(item.get("head"))
            sub = _clean(item.get("sub"))
            bullets = [b for b in (_clean(x) for x in (item.get("bullets") or [])) if b]

            if is_skills:
                # "Languages: Python, SQL, Java" — one line, which is how a
                # skills block is written and how a keyword search reads it.
                line = ", ".join(bullets)
                text = f"{head}: {line}" if head and line else head or line
                if text:
                    para = doc.add_paragraph()
                    para.paragraph_format.space_after = Pt(2)
                    if head and line:
                        para.add_run(f"{head}: ").bold = True
                        para.add_run(line)
                    else:
                        para.add_run(text)
                continue

            if head:
                para = doc.add_paragraph()
                para.add_run(head).bold = True
                para.paragraph_format.space_before = Pt(6)
                para.paragraph_format.space_after = Pt(0)
            if sub:
                para = doc.add_paragraph()
                run = para.add_run(sub)
                run.italic = True
                run.font.size = Pt(_BODY_PT - 0.5)
                para.paragraph_format.space_after = Pt(2)

            for bullet in bullets:
                para = doc.add_paragraph(style="List Bullet")
                para.add_run(bullet)
                para.paragraph_format.space_after = Pt(1)

    buffer = io.BytesIO()
    doc.save(buffer)
    return buffer.getvalue()


def _underline(paragraph) -> None:
    """A single hairline under a heading paragraph."""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), "6")       # eighths of a point
    bottom.set(qn("w:space"), "1")
    bottom.set(qn("w:color"), "999999")
    borders.append(bottom)
    paragraph._p.get_or_add_pPr().append(borders)


def build_text(struct: dict) -> str:
    """The resume as plain text, for the box on an application form.

    Not the same as the PDF's extracted text, and better: this is what we MEANT
    to say, rather than what an extractor recovered from a printed page. No
    trailing spaces, no double blank lines, and a real bullet character — a
    hyphen reads as a dash mid-sentence to some parsers, which is how a bullet
    list becomes one long run-on line.
    """
    lines: list[str] = []
    name = _clean(struct.get("name"))
    contact = _clean(struct.get("contact_line"))
    if name:
        lines.append(name)
    if contact:
        lines.append(contact)

    for section in struct.get("sections") or []:
        heading = _clean(section.get("heading"))
        is_skills = bool(_SKILLS_RE.search(heading))
        if heading:
            lines.extend(["", heading.upper()])

        for item in section.get("items") or []:
            head = _clean(item.get("head"))
            sub = _clean(item.get("sub"))
            bullets = [b for b in (_clean(x) for x in (item.get("bullets") or [])) if b]

            if is_skills:
                line = ", ".join(bullets)
                text = f"{head}: {line}" if head and line else head or line
                if text:
                    lines.append(text)
                continue

            if head and sub:
                # Both on one line, separated by an en dash. Dates stay inline
                # for the same reason they do in the PDF — see the invariants in
                # render_pdf.py.
                lines.append(f"{head} – {sub}")
            elif head or sub:
                lines.append(head or sub)
            for bullet in bullets:
                lines.append(f"• {bullet}")

    # Collapse any run of blank lines to one, and drop a leading blank.
    out: list[str] = []
    for line in lines:
        if not line.strip() and (not out or not out[-1].strip()):
            continue
        out.append(line.rstrip())
    return "\n".join(out).strip() + "\n"
