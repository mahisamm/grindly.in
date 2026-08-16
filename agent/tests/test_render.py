"""The rendered PDF is the product. These tests measure it, not the HTML.

Everything here that touches Chromium is marked `slow` and asserts on text read
BACK out of a real PDF, because the whole class of bug this file exists to catch
is invisible in the markup: a stylesheet that looks correct, renders correctly,
and extracts as something a parser cannot use.

Three such bugs have already shipped from this template and each has a test
below:

  * a CSS list marker painted bullets on the page and put none in the text layer
  * letter-spaced section headings extracted as "E D U C AT I O N", so the
    scorer — and any ATS — saw no Education section at all
  * right-aligned dates extracted five to eight lines away from the job they
    belonged to, leaving an employment history with floating date ranges
"""
from __future__ import annotations

import os

import pytest

import readiness
import render_pdf

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


def _struct(**over) -> dict:
    base = {
        "name": "Priya Ramanathan",
        "contact_line": "+91 90000 00000 | priya@example.com | linkedin.com/in/priya | github.com/priya",
        "sections": [
            {
                "heading": "Professional Summary",
                "items": [{"head": "", "sub": "", "bullets": [
                    "Backend engineer with seven years on payment systems, most "
                    "recently owning settlement for a platform processing 40000 "
                    "transactions a day.",
                ]}],
            },
            {
                "heading": "Experience",
                "items": [
                    {
                        "head": "Senior Software Engineer",
                        "sub": "Acme Payments | Jan 2021 - Present | Bengaluru, India",
                        "bullets": [
                            "Rebuilt the settlement pipeline, cutting reconciliation time from 6 hours to 40 minutes.",
                            "Led a team of 4 engineers through a migration to event-driven processing.",
                            "Introduced contract tests across 9 services, cutting release rollbacks from 3 a month to 0.",
                            "Owned the on-call rotation and brought median incident resolution down to 22 minutes.",
                        ],
                    },
                    {
                        "head": "Backend Engineer",
                        "sub": "Northwind Systems | Jun 2018 - Dec 2020 | Pune, India",
                        "bullets": [
                            "Built the internal reporting service used by 300 staff daily.",
                            "Automated release verification, removing 12 hours of manual testing per week.",
                            "Migrated 40 batch jobs off cron onto a scheduler with retries and alerting.",
                        ],
                    },
                ],
            },
            {
                "heading": "Education",
                "items": [{"head": "B.E. Computer Science",
                           "sub": "Pune University | 2014 - 2018", "bullets": []}],
            },
            {
                "heading": "Technical Skills",
                "items": [
                    {"head": "Languages", "sub": "",
                     "bullets": ["Java", "Python", "SQL", "Go"]},
                    {"head": "Platform", "sub": "",
                     "bullets": ["AWS", "Docker", "Kubernetes", "Kafka", "PostgreSQL", "Redis"]},
                ],
            },
        ],
    }
    base.update(over)
    return base


# ---------------------------------------------------------------------------
# meta-line ordering — pure, no browser
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("sub,expected_fields,expected_date", [
    ("Acme Payments | Jan 2021 - Present | Bengaluru, India",
     ["Acme Payments", "Jan 2021 - Present", "Bengaluru, India"], "Jan 2021 - Present"),
    # Date already first: order is canonical anyway, employer leads.
    ("2023 - Present | Piersoft Technologies",
     ["Piersoft Technologies", "2023 - Present"], "2023 - Present"),
    ("Pune University | 2014 - 2018", ["Pune University", "2014 - 2018"], "2014 - 2018"),
    ("Excellencia Junior College | Percentage: 94%",
     ["Excellencia Junior College", "Percentage: 94%"], None),
    ("Delhi Public School / Wisewoods International",
     ["Delhi Public School / Wisewoods International"], None),
    ("Expected May 2026 | IIIT Hyderabad", ["IIIT Hyderabad", "Expected May 2026"], "Expected May 2026"),
    ("", [], None),
])
def test_order_meta(sub, expected_fields, expected_date):
    fields, at = render_pdf.order_meta(sub)
    assert fields == expected_fields
    assert (fields[at] if at >= 0 else None) == expected_date


def test_order_meta_prefers_explicit_date_and_drops_the_duplicate():
    fields, at = render_pdf.order_meta("Acme | Jan 2021 - Present | Pune", "Jan 2021 - Present")
    assert fields == ["Acme", "Jan 2021 - Present", "Pune"]
    assert at == 1


def test_a_percentage_is_never_read_as_a_date():
    # "94%" and "Percentage: 78%" both contain digits and both sit exactly where
    # a date sits on an education line. Reading either as a date would move it
    # in front of the school and set it in date ink.
    for sub in ("St Xavier's | Percentage: 94%", "CBSE | 78%", "IIT Madras | CGPA 8.4/10"):
        _fields, at = render_pdf.order_meta(sub)
        assert at == -1, sub


# ---------------------------------------------------------------------------
# the round trip — a real PDF, read back
# ---------------------------------------------------------------------------

requires_chromium = pytest.mark.skipif(
    not render_pdf.renderer_available(), reason="playwright/chromium not installed"
)


@pytest.fixture(scope="module")
def rendered(tmp_path_factory) -> str:
    if not render_pdf.renderer_available():
        pytest.skip("playwright/chromium not installed")
    out = str(tmp_path_factory.mktemp("render") / "resume.pdf")
    result = render_pdf.render_fitted(_struct(), out)
    assert result.ok, result.reason
    assert os.path.getsize(out) > 0
    return out


@pytest.fixture(scope="module")
def back(rendered: str) -> str:
    text = render_pdf.extract_back(rendered)
    assert text.strip(), "the rendered PDF has no text layer at all"
    return text


@pytest.mark.slow
@requires_chromium
def test_section_headings_survive_letter_spacing(back):
    """The tracked-heading cliff.

    Chromium's letter-spacing becomes real inter-glyph distance in the PDF, and
    pdfminer inserts a space wherever that distance passes word_margin. At
    0.12em "EDUCATION" comes back as "E D U C AT I O N" and matches no section
    pattern; the template is pinned at 0.08em. This asserts the outcome rather
    than the number so the test still means something if the type scale moves.
    """
    for heading in ("EDUCATION", "EXPERIENCE", "TECHNICAL SKILLS"):
        assert heading in back, f"{heading!r} did not survive extraction: {back[:400]!r}"

    sections = readiness.find_sections(back)
    for name in ("education", "experience", "skills"):
        assert sections[name], f"the scorer cannot find the {name} section in our own output"


@pytest.mark.slow
@requires_chromium
def test_each_date_stays_with_its_own_role(back):
    """Employment dates must extract next to the job they belong to.

    Right-aligning the date is what a well-designed resume does and it is what
    this template did for exactly one afternoon: pdfminer emitted both dates
    together at the END of the Experience section, five and eight lines from
    their titles, so the extracted history read as two jobs and two unattached
    date ranges. Inline keeps the gap at one line. Two is the allowance; five is
    the bug.
    """
    lines = [ln.strip() for ln in back.splitlines() if ln.strip()]

    def line_index(exact: str) -> int:
        # Exact, not substring: "Backend Engineer" is a substring of nothing
        # here, but "Software Engineer" is a substring of "Senior Software
        # Engineer" and a substring match silently measures the gap from the
        # wrong role.
        for i, ln in enumerate(lines):
            if ln == exact:
                return i
        raise AssertionError(f"{exact!r} is not its own line: {lines}")

    def contains_index(needle: str) -> int:
        for i, ln in enumerate(lines):
            if needle in ln:
                return i
        raise AssertionError(f"{needle!r} missing from extracted text: {lines}")

    for title, date in (
        ("Senior Software Engineer", "Jan 2021 - Present"),
        ("Backend Engineer", "Jun 2018 - Dec 2020"),
        ("B.E. Computer Science", "2014 - 2018"),
    ):
        gap = contains_index(date) - line_index(title)
        assert 0 <= gap <= 2, (
            f"{date!r} extracted {gap} lines from {title!r} — a parser cannot "
            f"tell which role it belongs to"
        )


@pytest.mark.slow
@requires_chromium
def test_bullets_reach_the_text_layer(back):
    """A CSS list marker paints on the page and extracts as nothing.

    With `list-style: disc` the rendered PDF looked perfect and `readiness`
    scored it as a wall of prose, because `_glyph_bullets` found zero bullet
    glyphs. The template emits U+2022 as real text inside each <li>.
    """
    bullets = readiness._glyph_bullets(back)
    assert len(bullets) >= 6, f"only {len(bullets)} bullets survived extraction"


@pytest.mark.slow
@requires_chromium
def test_the_name_extracts_before_the_contact_line(back):
    """Reading order at the top of the page.

    Centred, the name sits in a narrow box above a wide one and pdfminer emits
    the wider box first, so the extracted resume opens with the candidate's
    address and a parser records it as their name. Left-aligned, vertical order
    wins. Long contact lines are the failure case, so this uses one.
    """
    lines = [ln.strip() for ln in back.splitlines() if ln.strip()]
    assert lines[0] == "Priya Ramanathan"
    assert "priya@example.com" in lines[1]


@pytest.mark.slow
@requires_chromium
def test_the_contact_separator_does_not_eat_the_fields(back):
    """The middot between contact fields must stay a separator, not a joiner."""
    assert readiness.find_emails(back) == ["priya@example.com"]
    assert readiness.find_phones(back), "the phone number did not survive"
    links = " ".join(readiness.find_links(back))
    assert "linkedin.com/in/priya" in links
    assert "github.com/priya" in links


@pytest.mark.slow
@requires_chromium
def test_a_contact_field_never_breaks_across_lines():
    """A URL split by a line wrap is a dead link.

    Chromium treats a hyphen as a break opportunity, so a header wide enough to
    wrap broke "github.com/priya-r" after the hyphen. The PDF looked fine; the
    text layer carried "github.com/priya-" and a stray "r", so a recruiter
    copying the address got a 404 and the scorer reported no profile link on a
    resume that had one. Each field is nowrap and the line breaks between them.
    """
    import tempfile

    struct = _struct(contact_line=(
        "+91 90000 00000 | priya.ramanathan@example.com | Bengaluru, India | "
        "linkedin.com/in/priya-ramanathan-b1234 | github.com/priya-r | "
        "priya-ramanathan.dev"
    ))
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "wide.pdf")
        assert render_pdf.render_fitted(struct, out).ok
        text = render_pdf.extract_back(out)

    links = " ".join(readiness.find_links(text))
    for url in ("linkedin.com/in/priya-ramanathan-b1234", "github.com/priya-r"):
        assert url in links, f"{url} was broken by a line wrap: {links!r}"
    # A bare portfolio domain is not something `find_links` recognises — its
    # pattern is deliberately narrow so "Next.js" and "React.js" in a skills
    # line are not read as web addresses. It still has to survive intact in the
    # text, because a human reads this line too.
    flat = " ".join(text.split())
    assert "priya-ramanathan.dev" in flat
    assert readiness.find_emails(text) == ["priya.ramanathan@example.com"]


@pytest.mark.slow
@requires_chromium
def test_a_summary_renders_as_prose_not_as_a_bullet(back):
    """A one-line Professional Summary set as a lone bullet under its own
    heading is the clearest possible tell that a document was assembled from a
    template. It renders as a paragraph."""
    for line in back.splitlines():
        if "Backend engineer with seven years" in line:
            assert not line.strip().startswith(render_pdf.BULLET_GLYPH)
            return
    raise AssertionError("the summary is missing from the rendered resume")


@pytest.mark.slow
@requires_chromium
def test_our_own_output_is_not_flagged_as_two_column(back):
    """The layout detector must not fire on the layout we ship."""
    lines = [ln for ln in back.splitlines() if ln.strip()]
    assert not readiness.detect_two_column(lines)["is_two_column"]


@pytest.mark.slow
@requires_chromium
def test_the_page_has_margins(rendered):
    """Text must not run into the paper edge.

    We print with prefer_css_page_size=True, which makes the @page rule win over
    Chromium's defaults — for the size AND for the margin. With `margin: 0` in
    that rule, the margin dict handed to page.pdf() was silently ignored and
    every resume this product rendered had its text flush against all four
    edges. Nothing failed, nothing warned, and it is invisible on screen beside
    white browser chrome.

    Asserted against the actual glyph positions rather than against the CSS, so
    it measures the artefact instead of the intent. 10mm is the floor, well
    under the 15mm we ask for, because the point is to catch zero.
    """
    from pdfminer.high_level import extract_pages
    from pdfminer.layout import LTChar, LTTextContainer

    MM = 72 / 25.4  # PDF points per millimetre
    page = next(iter(extract_pages(rendered)))
    width, height = page.width, page.height

    xs, ys = [], []
    for element in page:
        if not isinstance(element, LTTextContainer):
            continue
        for line in element:
            for ch in line:
                if isinstance(ch, LTChar) and ch.get_text().strip():
                    xs.extend((ch.x0, ch.x1))
                    ys.extend((ch.y0, ch.y1))

    assert xs, "no glyphs on the page"
    for name, gap in (
        ("left", min(xs)),
        ("right", width - max(xs)),
        ("top", height - max(ys)),
        ("bottom", min(ys)),
    ):
        assert gap >= 10 * MM, (
            f"only {gap / MM:.1f}mm of {name} margin — the text is running into "
            f"the edge of the paper"
        )


@pytest.mark.slow
@requires_chromium
def test_a_skills_block_keeps_one_category_per_line(back):
    """Both shapes of skills section must print as "Category: a, b, c" lines.

    A model asked for a skills section returns its groups as BULLETS —
    ["Languages: Python, SQL", "Cloud: AWS, Docker"] — which is exactly what the
    extraction prompt asks for. Joining those with commas produced a single
    run-on line with every category label buried mid-sentence, on the one block
    a recruiter scans for keywords.
    """
    struct = _struct()
    struct["sections"] = [
        s for s in struct["sections"] if s["heading"] != "Technical Skills"
    ] + [{
        "heading": "Technical Skills",
        "items": [{"head": "", "sub": "", "bullets": [
            "Languages: Java, Python, SQL",
            "Platform: AWS, Docker, Kubernetes",
            "Data: Kafka, PostgreSQL, Redis",
        ]}],
    }]

    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "skills.pdf")
        assert render_pdf.render_fitted(struct, out).ok
        text = render_pdf.extract_back(out)

    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    for label in ("Languages:", "Platform:", "Data:"):
        starts = [ln for ln in lines if ln.startswith(label)]
        assert starts, f"{label} does not start a line of its own: {lines[-6:]}"


@pytest.mark.slow
@requires_chromium
def test_a_clean_rebuild_clears_the_shippable_floor(back):
    """The mechanical bands are ours to get right, so this asserts them.

    readable, fields and structure measure the document rather than the career:
    text that survives extraction, contact details a parser can lift, standard
    headings, real bullets, one column. Every one of those is a property of this
    template, so anything short of full marks on all three is our bug and not
    the candidate's resume. impact and coverage depend on what the person
    actually did and are deliberately not asserted here.
    """
    report = readiness.score(back)
    for band in ("readable", "fields", "structure"):
        assert report["bands"][band]["score"] == 100, (
            f"{band} scored {report['bands'][band]['score']} on our own template: "
            + "; ".join(f["problem"] for f in report["findings"] if f["band"] == band)
        )
    assert report["score"] >= readiness.SHIPPABLE_FLOOR, report["findings"]
