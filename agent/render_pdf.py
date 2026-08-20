"""Structured resume -> single-column PDF, rendered by headless Chromium.

This replaces the LaTeX/Tectonic path the auto-apply build used. Two reasons,
and the second is the one that matters:

  1. Tectonic is a separate ~50 MB binary with a package cache that has to warm
     up on first run. Every deploy target needs it installed and every developer
     needs it before they can see the product work. Chromium is already a hard
     dependency here — `playwright install chromium` is in the setup path
     because resume parsing needs it — so the compiler is free.

  2. LaTeX escaping is a security surface. `latex_resume.py` carried a denylist
     of `\\write18`, `\\openout` and friends precisely because a resume is
     untrusted text being fed to a Turing-complete language with filesystem
     access. HTML has one escape function, it is total, and Chromium runs the
     page with JavaScript disabled and no network access.

The template is deliberately boring, and every rule in it is a parser rule
rather than a taste rule:

  * One column. Two columns are the single most common reason a well-designed
    resume extracts as interleaved nonsense.
  * No tables, no floats, no absolute positioning. Text lands in the PDF in the
    order it is read.
  * No images, no icon fonts. An icon with no Unicode mapping extracts as
    `(cid:132)`, which is what `readiness._band_readable` penalises.
  * System serif/sans only, embedded by Chromium as real glyphs with a text
    layer. Never `-webkit-text-stroke`, never text-as-background-image.
  * Section headings are plain words in the document order a parser expects.

`render()` never raises. A resume that will not render must degrade to "we could
not rebuild this", never take down the request that asked for it.
"""
from __future__ import annotations

import html
import os
import re
import shutil
import tempfile

# Page geometry, in millimetres. A4 because the entire target market prints A4.
#
# 15mm sides rather than 14: at 14mm an A4 line holds ~95 characters at body
# size, which is past the point where the eye loses its place returning to the
# next line. The extra 2mm costs roughly one word per line and buys a measure
# that reads like a document instead of a spreadsheet.
PAGE_FORMAT = "A4"
MARGIN_MM = {"top": "15mm", "right": "15mm", "bottom": "15mm", "left": "15mm"}

# A rebuilt one-page resume that spills to three pages is not an improvement, so
# the caller checks this and drops the variant.
MAX_PAGES = 2

RENDER_TIMEOUT_MS = int(os.environ.get("GRINDLY_RENDER_TIMEOUT_MS", "20000"))

# Chromium prints at 96 CSS px per inch regardless of the host's DPI setting, so
# a pt-based scale is stable across machines. Everything below is derived from
# BASE_PT to keep the vertical rhythm consistent when the caller tightens it.
BASE_PT = 9.8

# ONE family for the whole document, and the reason is not taste.
#
# The old template set Georgia for body text and Arial for headings, meta lines
# and the contact line. Two problems, both visible in the output:
#
#   1. Neither font exists in the production container. Georgia and Arial are
#      Microsoft fonts; the image installs Playwright's Debian dependencies,
#      which include the Liberation family and nothing from Microsoft. So the
#      resume a developer previewed on Windows and the resume a user downloaded
#      from the server were set in different typefaces, at different widths,
#      breaking differently across pages. Liberation Sans is metric-compatible
#      with Arial and Liberation Serif with Times New Roman, so naming both puts
#      Windows and the container on the same metrics rather than merely on
#      "some sans-serif".
#
#   2. Georgia's numerals are old-style — 3, 4, 5, 7 and 9 hang below the
#      baseline. On running text that is elegant; on a resume, where a third of
#      the numerals are years and percentages sitting next to capital letters,
#      it reads as wobbly and slightly broken. `2023 - Present` in Georgia looks
#      like a typesetting accident. Every face named here has lining figures.
#
# Sans rather than serif because a resume is now read on a screen far more often
# than on paper, and because tabular lining numerals make a right-aligned date
# column line up exactly.
FONT_STACK = (
    '"Liberation Sans", Arial, "Helvetica Neue", Helvetica, "Nimbus Sans", '
    '"DejaVu Sans", sans-serif'
)

# Ink. Near-black rather than pure black for body text: #000 on white at 9.8pt
# renders with noticeably harsher antialiasing on screen, and the difference is
# invisible on paper. Meta lines step down one level so the eye reads title
# before employer without needing a second typeface to say so.
INK = "#111111"
INK_META = "#333333"
# The one grey the document uses for anything that is not a letter: the rule
# under a section heading and the middots between fields. It was #111 — the same
# ink as the text — and a full-strength full-width line under all six headings is
# what made a finished resume read as a form to be filled in rather than a
# document to be read. The heading still announces the section; the rule now only
# has to separate it, and 0.5pt at 40% grey still prints on a laser printer.
RULE = "#999999"


def _esc(value: object) -> str:
    """Total HTML escaping. Every user-controlled string goes through this."""
    return html.escape(str(value if value is not None else ""), quote=True)


# Characters that carry no text meaning but do reach the text layer. Stripped at
# render time so a rebuilt resume never inherits the artefacts we penalise other
# resumes for having.
_CID_RE = re.compile(r"\(cid:\d+\)")
# The Unicode private use area, written as ESCAPES rather than literal
# characters. As literals, U+E000 and U+F8FF are invisible, and an editor or an
# encoding round-trip that drops them silently leaves `[-]` behind — a class
# that matches a plain ASCII hyphen. That is exactly what happened here: every
# hyphen was being stripped out of every resume before it was rendered, so
# "Aug 2022 - May 2026" printed as "Aug 2022 May 2026", no date range was
# readable in the output, and the loss was then misdiagnosed as a Chromium font
# problem. An invisible character in a regex is a bug waiting to be introduced.
_PUA_RE = re.compile("[\ue000-\uf8ff]")
_WS_RE = re.compile(r"[ \t ]+")


# NOTE, because the obvious "fix" is wrong and was briefly applied here: there is
# no need to convert ASCII hyphens to en dashes. A probe over Georgia, Arial,
# Times New Roman, Calibri, Segoe UI and Cambria showed hyphens vanishing from
# every rendered PDF, and the conclusion drawn was that Chromium's text layer
# cannot carry U+002D. It can. What was actually happening is that `_PUA_RE`
# above had been corrupted into `[-]` and was deleting every hyphen from the
# text before it reached the renderer. With that fixed, "Aug 2022 - May 2026"
# round-trips exactly. Rewriting the user's characters is a change that needs a
# reason, and this one had none.

# Emitted as literal text at the start of every bullet.
#
# A CSS list marker is generated content: drawn on the page, absent from the
# text layer. `readiness._glyph_bullets` therefore found zero bullets in our own
# output and the structure band scored a clean rebuild as prose. U+2022 survives
# extraction intact in every font tested.
BULLET_GLYPH = "•"


def clean(value: object) -> str:
    """Normalise a string for printing: no icon debris, no runaway whitespace.

    Removes only what carries no meaning. It does NOT rewrite the candidate's
    punctuation, spelling or wording — this function runs on their own words on
    their way onto a document they will send to an employer.
    """
    s = str(value if value is not None else "")
    s = _CID_RE.sub("", s)
    s = _PUA_RE.sub("", s)
    s = _WS_RE.sub(" ", s)
    return s.strip()


def _css(density: float = 1.0) -> str:
    """The whole stylesheet. `density` < 1 tightens leading to win a page.

    Nothing here uses a webfont, a background image, or a colour that is not
    near-black: a resume is printed and photocopied, and a grey bullet at 60%
    opacity is a bullet a scanner loses.

    The vertical rhythm is the design. Everything on this page is the same
    typeface at four sizes, so the ONLY thing telling a reader where one section
    ends and the next begins is space — and the previous version of this file
    did not give it any. Section heading to next section was 8pt; item to item
    was 5pt. Three points of difference over a full page reads as no difference,
    so five identical full-width rules marched down the page with evenly-spaced
    text between them and the whole document looked like a table with the cell
    borders half turned off. The ratios below are deliberate and roughly 3:1
    from the largest gap to the smallest:

        section to section      15.5pt     "a new subject starts here"
        heading to its content   4.5pt     "this belongs to that heading"
        item to item             7.0pt     "different job, same subject"
        line to line inside      2.0pt

    A rule is drawn under a section heading and nowhere else. The header's own
    underline is gone: it sat ten points above the first section's rule, and two
    parallel full-width lines that close together at the top of a page is what
    made the document read as a form to be filled in.
    """
    base = BASE_PT
    # The page margin is declared HERE, in CSS, and not only in the argument to
    # page.pdf().
    #
    # We print with prefer_css_page_size=True so the @page size wins over
    # Chromium's default letter/A4 guess. That flag also makes the @page MARGIN
    # win, and this rule used to say `margin: 0` — so the margin dict passed to
    # page.pdf() was silently ignored and every resume this product has ever
    # rendered had its text running into all four paper edges. It is invisible
    # on screen next to a white browser chrome and obvious the moment anyone
    # prints one or opens it beside another PDF.
    return f"""
      @page {{ size: {PAGE_FORMAT}; margin: {MARGIN_MM["top"]} {MARGIN_MM["right"]} {MARGIN_MM["bottom"]} {MARGIN_MM["left"]}; }}
      * {{ box-sizing: border-box; }}
      html, body {{ margin: 0; padding: 0; }}
      body {{
        font-family: {FONT_STACK};
        font-size: {base}pt;
        line-height: {1.38 * density:.3f};
        color: {INK};
        background: #ffffff;
        -webkit-font-smoothing: antialiased;
        /* Lining, fixed-width digits. Years and percentages sit beside capital
           letters all over a resume, and proportional old-style figures make
           "2023 - Present" look mis-set. Tabular widths also make the date
           column line up on the right edge without a table. */
        font-variant-numeric: lining-nums tabular-nums;
      }}
      .doc {{ padding: 0; }}

      /* LEFT-aligned, not centred, and this is a correctness rule rather than a
         taste one.

         Centred, the name sits in a narrow box floating above a wide contact
         box. Once the contact line passes about 62 characters — which it does
         the moment someone lists a city, a phone, an email and two profile
         links — pdfminer's layout analysis emits the wider box FIRST, and the
         extracted text begins "Hyderabad, India | +91 ... | github.com/..."
         with the name below it. A parser reads the first line as the
         candidate's name, so the rebuilt resume introduced its owner as their
         own address. Measured across five contact lengths: correct at 29 and 61
         characters, wrong at 86, 116 and 144. Left-aligned, all five are
         correct, because both boxes share a left edge and vertical order wins. */
      header.hd {{
        text-align: left;
        margin-bottom: {18 * density:.1f}pt;
      }}
      /* The name, set as a letterhead rather than as a document title.
         Three things were wrong with the first version and all three were
         about ratio rather than about the name itself.

         SIZE. 2.05x body against a contact line at 0.92x is a ratio of 2.2,
         which is not enough separation for the eye to read one as the person
         and the other as how to reach them. They read as a heading and a
         subheading of equal standing. 2.2x over 0.88x is a ratio of 2.5 and
         the header resolves into a name with an address under it.

         TRACKING. Grotesks are drawn for text sizes and are fitted too loosely
         when set large: the standard correction for display-set Helvetica or
         Arial is about -1.5%, and the previous -0.5% was close enough to zero
         to leave the name looking like default browser output. Measured
         against the extraction cliff for completeness — rendered and read back,
         the name survives as one string at -0.012, 0.02, 0.035, 0.05 and 0.08em
         and shatters into "M a h e n d h a r" at 0.12em, the same threshold
         `h2.sec-h` documents. Negative tracking is nowhere near it.

         AIR. 4pt between a 21pt line and an 8.6pt line is not a gap, it is a
         collision: the descenders of the name land in the contact line's
         ascenders. 6pt reads as deliberate. */
      h1.name {{
        font-size: {base * 2.3:.1f}pt;
        font-weight: 700;
        letter-spacing: -0.012em;
        margin: 0 0 {3 * density:.1f}pt;
        line-height: 1.02;
      }}
      /* A short letterhead stroke under the name — the one purely aesthetic
         mark on the page, and it is safe precisely because it is GENERATED
         CONTENT: it paints and never enters the text layer, so no extractor
         can misread it (unlike the full-width header underline this template
         deliberately removed, this is a third the width of the name and reads
         as a mark, not a form rule). Ink, not brand red: the document belongs
         to the candidate, not to us. */
      h1.name::after {{
        content: "";
        display: block;
        width: {base * 3.2:.1f}pt;
        height: 2pt;
        margin: {3.5 * density:.1f}pt 0 {4 * density:.1f}pt;
        background: {INK};
      }}
      p.contact {{
        font-size: {base * 0.88:.1f}pt;
        color: {INK_META};
        /* Small grey text closes up as it shrinks. A fraction of a point back
           between the glyphs keeps an email address and a phone number legible
           at 8.6pt, which is the size at which people actually squint at them. */
        letter-spacing: 0.008em;
        margin: 0;
        line-height: 1.4;
      }}
      /* Each contact field is unbreakable; the line wraps BETWEEN fields.
         Chromium treats a hyphen as a break opportunity, so a header ending in
         "github.com/priya-r" broke after the hyphen and the extracted text
         carried "github.com/priya-" on one line and "r" on the next. A
         recruiter copying that gets a dead link, and `readiness` scores the
         profile link as missing — on a resume that has one. */
      p.contact .f {{ white-space: nowrap; }}
      /* An anchor that looks exactly like the text around it. The link is for
         clicking, not for decorating: browser-default blue and an underline in
         a printed resume read as a mistake, and neither changes what an
         extractor recovers. */
      a {{ color: inherit; text-decoration: none; }}
      /* The separator between contact fields, dimmed so the fields themselves
         read as the content. It is real text in the PDF, not a border, so an
         extractor still sees the delimiter it needs to split the header on. */
      p.contact .sep {{ color: #999999; padding: 0 {base * 0.34:.1f}pt; }}

      section.sec {{ margin-top: {17 * density:.1f}pt; }}
      section.sec:first-of-type {{ margin-top: 0; }}
      h2.sec-h {{
        font-size: {base * 0.98:.1f}pt;
        font-weight: 700;
        text-transform: uppercase;
        /* 0.08em, and this number is measured rather than chosen.
           pdfminer inserts a word break when the gap between two glyphs exceeds
           word_margin — 0.1 × the font size by default. Tracked headings are
           therefore a cliff, not a gradient: rendered and read back at 9.2pt,
           0.04 / 0.06 / 0.08 / 0.10em all extract as "EDUCATION", and 0.12em
           extracts as "E D U C AT I O N". The first draft of this template used
           0.13em, which read beautifully and made every section heading
           invisible to `readiness.find_sections` — the rebuilt resume was told
           it had no Education section, and a real ATS would have agreed. Do not
           raise this past 0.10em without re-running tests/test_render.py. */
        letter-spacing: 0.08em;
        margin: 0 0 {4.5 * density:.1f}pt;
        padding-bottom: {2.5 * density:.1f}pt;
        border-bottom: 0.5pt solid {RULE};
        page-break-after: avoid;
      }}

      article.item {{
        margin-bottom: {7 * density:.1f}pt;
        page-break-inside: avoid;
      }}
      article.item:last-child {{ margin-bottom: 0; }}

      /* A job title, and the one line on the page that is not allowed to
         outweigh the section heading above it. Bold does the work; a full point
         of extra size on top of bold made every role read as its own heading
         and flattened the document into a list of shouted lines. */
      p.item-head {{
        font-size: {base * 1.02:.1f}pt;
        font-weight: 700;
        margin: 0;
        line-height: 1.3;
      }}
      /* Employer · dates · location, on one line under the title.
         Everything on this line is inline text in a single block, which is what
         keeps the date attached to its own role in the extracted text — see
         `order_meta`. The date is separated by tone rather than by position:
         full-strength ink against the meta grey, so it reads as its own field
         without moving a single glyph. */
      p.item-sub {{
        font-size: {base * 0.94:.1f}pt;
        color: {INK_META};
        margin: {1.5 * density:.1f}pt 0 0;
        line-height: 1.3;
      }}
      p.item-sub .date {{ color: {INK}; }}
      p.item-sub .sep {{ color: #999999; padding: 0 {base * 0.30:.1f}pt; }}
      /* list-style is NONE and the glyph is real text inside the <li>. A CSS
         marker is generated content: it paints on the page and never reaches
         the text layer, so an extractor sees a wall of prose. Hanging indent
         via text-indent keeps the wrapped lines aligned under the text rather
         than under the bullet. */
      ul.bullets {{
        margin: {3.5 * density:.1f}pt 0 0;
        padding-left: 0;
        list-style: none;
      }}
      ul.bullets li {{
        margin: 0 0 {2 * density:.1f}pt;
        line-height: {1.36 * density:.3f};
        padding-left: {base * 1.05:.1f}pt;
        text-indent: -{base * 1.05:.1f}pt;
      }}
      ul.bullets li:last-child {{ margin-bottom: 0; }}
      ul.bullets li .b {{ padding-right: {base * 0.40:.1f}pt; }}

      p.skills-line {{ margin: 0 0 {3 * density:.1f}pt; line-height: 1.4; }}
      p.skills-line:last-child {{ margin-bottom: 0; }}
      /* The category is the label and the skills are the content, so the label
         steps back rather than shouting in bold. Bold on both halves of every
         line — which is what "Languages:" in bold beside bold-weight body text
         amounts to at this size — is why the old skills block read as dense. */
      p.skills-line .cat {{ font-weight: 700; }}

      /* A summary or profile paragraph. Real prose, not a one-item bullet
         list: an experienced candidate opens with two lines about what they do,
         and rendering that as a lone bullet under a heading looks like a
         mistake. */
      p.prose {{ margin: 0 0 {3 * density:.1f}pt; line-height: 1.42; }}
      p.prose:last-child {{ margin-bottom: 0; }}

      /* Never break a paragraph or a bullet so that one line of it sits alone
         at the foot or the head of a page. `article.item` already keeps a whole
         role together, but a summary paragraph and a long bullet are not items
         and could strand a line on their own across the page break. */
      p, li {{ orphans: 2; widows: 2; }}
    """


# --------------------------------------------------------------------------
# meta-line parsing
# --------------------------------------------------------------------------

# A date on a resume: a month-year, a numeric month/year, or a bare year, on its
# own or as a range. Used ONLY to decide which segment of an item's meta line
# gets right-aligned; nothing here changes a character of what is printed.
_D = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{4}|\d{1,2}[/-]\d{2,4}|(?:19|20)\d{2}"
_OPEN = r"present|current|now|ongoing|date|till\s+date"
# An optional qualifier people really write in front of a graduation date.
_QUAL = r"(?:expected|expct?d|graduating|graduation|anticipated|since|class\s+of)\s*:?\s*"
_DATE_SEGMENT_RE = re.compile(
    rf"^(?:{_QUAL})?(?:{_D})\s*(?:[-–—]|to|until|through)?\s*(?:{_D}|{_OPEN})?\s*$",
    re.I,
)
# Separators a header or meta line is built from. The renderer emits a middot;
# extracted source resumes overwhelmingly use a pipe or a bullet.
_SEPARATOR_RE = re.compile(r"\s*[|•·∙]\s*")

# The separator printed between contact fields. A real character in the text
# layer, so an extractor still sees where one field ends and the next begins.
CONTACT_SEP = "·"


def order_meta(sub: str, explicit_date: str = "") -> tuple[list[str], int]:
    """An item's meta line as ordered fields, plus which one is the date.

    Returns (fields, date_index), date_index -1 when there is no date. Fields
    are put into one canonical order — employer, then date, then location —
    because source resumes put them in every order there is, and a rebuilt
    resume where every role reads the same way is easier to scan than one that
    inherits four different conventions from four different sections.

    THE DATE STAYS INLINE, and that is a measured decision rather than a
    stylistic one. Setting the date hard right against the job title is what a
    well-designed resume does and it looks markedly better — but rendered that
    way and read back, pdfminer detaches every date from its role and emits
    them together at the end of the section: "AI Intern / Piersoft / <bullets> /
    AI Tech Lead / <bullets> / 2023 - Present / Jun 2025 - Aug 2025". A parser
    filling an employment-history table then has two roles and two floating date
    ranges with nothing connecting them.

    Measured across four layouts (flex siblings, a floated span, a flex spacer,
    and inline) with two extractors: pdfminer put the date 5 to 8 lines away
    from its own title under all three right-aligned layouts, and one line away
    under the inline one. pypdf kept them together in all four. We render for
    the worse of the two, because we do not get to choose which parser a
    recruiter runs.

    An education line — "Excellencia Junior College | Percentage: 94%" — has no
    date segment and comes through with its fields untouched; "94%" is not
    mistaken for a year.
    """
    parts = [p.strip() for p in _SEPARATOR_RE.split(sub or "") if p.strip()]

    if explicit_date:
        date = explicit_date.strip()
        # Drop a duplicate of the same date already sitting in the meta line.
        parts = [p for p in parts if p != date]
    else:
        date = ""
        for i, part in enumerate(parts):
            # A lone segment is all-or-nothing: carving a trailing date out of
            # "Software Engineer at Acme since Jan 2020" leaves a dangling
            # "since", so only whole segments count as dates.
            if _DATE_SEGMENT_RE.match(part):
                date = part
                parts = parts[:i] + parts[i + 1:]
                break

    if not date:
        return parts, -1
    # After the employer, before the location.
    at = 1 if parts else 0
    return parts[:at] + [date] + parts[at:], at


def format_contact(line: str) -> list[str]:
    """The contact header split into its fields, in order.

    Kept as a list so the template can print its own separator between them
    rather than inheriting whichever character the source resume happened to
    use — sources arrive with pipes, bullets, middots, and mixtures of all
    three in one line.
    """
    return [p for p in (s.strip() for s in _SEPARATOR_RE.split(line or "")) if p]


_PROSE_HEADING_RE = re.compile(
    r"summary|profile|objective|about\s*me|career\s+goal|professional\s+overview", re.I,
)
_SKILLS_HEADING_RE = re.compile(
    r"skill|tool|technolog|language|framework|competenc|stack|interest|hobb", re.I,
)
# "Languages: Python, SQL" — a skills bullet that carries its own category
# label. The label is capped at 40 characters so a sentence containing a colon
# ("Built a pipeline in Python: 40 jobs a night") is not mistaken for one.
_SKILL_GROUP_RE = re.compile(r"^[^:]{2,40}:\s*\S")


# Hosts whose profile URLs get a short human label when link_style="label".
_LINK_LABELS = (
    ("linkedin.com", "LinkedIn"),
    ("github.com", "GitHub"),
    ("gitlab.com", "GitLab"),
    ("leetcode.com", "LeetCode"),
    ("kaggle.com", "Kaggle"),
    ("behance.net", "Behance"),
    ("dribbble.com", "Dribbble"),
    ("medium.com", "Medium"),
    ("stackoverflow.com", "Stack Overflow"),
)

_URLISH_RE = re.compile(r"^(https?://|www\.)|(^|\.)[a-z0-9-]+\.(com|org|net|io|dev|in|me|co)(/|$)", re.I)
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _href_for(field: str) -> str | None:
    """The address a contact field should point at, or None if it is not a link.

    Deliberately conservative. A field that is not obviously an address is left
    as plain text: a spurious anchor around someone's city name is worse than a
    missing one around their portfolio.
    """
    value = (field or "").strip()
    if not value:
        return None
    if _EMAIL_RE.match(value):
        return "mailto:" + value
    if _URLISH_RE.search(value):
        return value if value.lower().startswith(("http://", "https://")) else "https://" + value
    return None


def _label_for(field: str) -> str | None:
    """"LinkedIn" for a linkedin.com address, and so on."""
    low = (field or "").lower()
    for host, label in _LINK_LABELS:
        if host in low:
            return label
    return None


def contact_field_html(field: str, link_style: str = "url") -> str:
    """One field of the contact header.

    THE DEFAULT PRINTS THE ADDRESS AND MAKES IT CLICKABLE, and that combination
    is the whole point rather than a compromise. An extractor reads the text
    layer, so what it recovers is identical either way — the anchor costs it
    nothing. A human opening the PDF gets a link they can follow. There is no
    trade here to make, which is why it is not an option.

    `link_style="label"` prints "LinkedIn" instead of the address. It looks
    tidier and it is what most resumes do, and it is the exact practice this
    product exists to warn people about: the address then lives only in the PDF's
    link annotation, which every text extractor ignores, so an application form
    asking for a profile URL gets nothing and readiness scores the resume as
    having no visible link. Offered because it is the user's document and their
    call — with the consequence stated where they choose it, not buried here.
    """
    href = _href_for(field)
    if not href:
        return f'<span class="f">{_esc(field)}</span>'

    text = field
    if link_style == "label":
        text = _label_for(field) or field
    return f'<span class="f"><a href="{_esc(href)}">{_esc(text)}</a></span>'


def build_html(struct: dict, density: float = 1.0) -> str:
    """The full HTML document for a resume struct.

    `struct` is the shape `resume_optimize` already produces::

        {"name": str, "contact_line": str,
         "sections": [{"heading": str,
                       "items": [{"head": str, "sub": str, "bullets": [str]}]}]}

    A skills-style section renders as `Head: bullet, bullet` lines rather than a
    bulleted list, because that is how a skills block is written and how a
    keyword search reads it. Everything else renders as head / sub / bullets.
    """
    name = clean(struct.get("name"))
    contact = clean(struct.get("contact_line"))

    parts: list[str] = [
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
        f"<title>{_esc(name or 'Resume')}</title>",
        f"<style>{_css(density)}</style></head><body><div class=\"doc\">",
    ]

    if name or contact:
        parts.append('<header class="hd">')
        if name:
            parts.append(f'<h1 class="name">{_esc(name)}</h1>')
        fields = format_contact(contact)
        if fields:
            # "url" unless the struct says otherwise. An unknown value falls
            # back to the safe one rather than to the tidy one.
            link_style = "label" if struct.get("link_style") == "label" else "url"
            sep = f'<span class="sep">{CONTACT_SEP}</span>'
            parts.append('<p class="contact">'
                         + sep.join(contact_field_html(f, link_style) for f in fields)
                         + "</p>")
        parts.append("</header>")

    for sec in struct.get("sections") or []:
        heading = clean(sec.get("heading"))
        items = sec.get("items") or []
        if not heading and not items:
            continue
        parts.append('<section class="sec">')
        if heading:
            parts.append(f'<h2 class="sec-h">{_esc(heading)}</h2>')

        skills_like = bool(_SKILLS_HEADING_RE.search(heading)) if heading else False
        prose_like = bool(_PROSE_HEADING_RE.search(heading)) if heading else False

        for item in items:
            head = clean(item.get("head"))
            # An explicit `date` field wins; otherwise it is found inside the
            # meta line. Explicit support exists so the rewrite step can hand
            # one over directly, without the renderer having to infer it.
            meta, date_at = order_meta(clean(item.get("sub")), clean(item.get("date")))
            bullets = [clean(b) for b in (item.get("bullets") or [])]
            bullets = [b for b in bullets if b]

            if skills_like:
                # A skills section arrives in one of two shapes and both have to
                # come out as "Category: a, b, c" lines.
                #
                #   head="Languages", bullets=["Python","SQL"]   — grouped item
                #   head="",  bullets=["Languages: Python, SQL",
                #                      "Cloud: AWS, Docker"]     — grouped bullets
                #
                # The second is what the extraction prompt actually asks a model
                # for, and joining those bullets with commas — which is what
                # this did — produced one run-on line reading "Languages:
                # Python, SQL, Java, Data: Airflow, Snowflake, Cloud: AWS,
                # Docker, Git". Every category label buried mid-sentence, on the
                # block a recruiter scans first.
                labelled = [b for b in bullets if _SKILL_GROUP_RE.match(b)]
                if not head and len(labelled) == len(bullets) and bullets:
                    for bullet in bullets:
                        label, _, rest = bullet.partition(":")
                        parts.append(
                            f'<p class="skills-line"><span class="cat">{_esc(label.strip())}:</span> '
                            f"{_esc(rest.strip())}</p>"
                        )
                    continue

                # "Languages: Python, C++, SQL" on one line. A bulleted skills
                # list wastes a third of the page and reads worse.
                body = ", ".join(bullets)
                if head and body:
                    parts.append(f'<p class="skills-line"><span class="cat">{_esc(head)}:</span> {_esc(body)}</p>')
                elif head:
                    parts.append(f'<p class="skills-line">{_esc(head)}</p>')
                elif body:
                    parts.append(f'<p class="skills-line">{_esc(body)}</p>')
                continue

            if prose_like:
                # A summary is prose. Rendering it as a bulleted list under a
                # heading called "Professional Summary" is the single clearest
                # tell that a document was assembled by a template rather than
                # written by its owner.
                for line in ([head] if head else []) + bullets:
                    parts.append(f'<p class="prose">{_esc(line)}</p>')
                continue

            parts.append('<article class="item">')
            if head:
                parts.append(f'<p class="item-head">{_esc(head)}</p>')
            if meta:
                rendered = [
                    f'<span class="date">{_esc(f)}</span>' if i == date_at else _esc(f)
                    for i, f in enumerate(meta)
                ]
                sep = f'<span class="sep">{CONTACT_SEP}</span>'
                parts.append(f'<p class="item-sub">{sep.join(rendered)}</p>')
            if bullets:
                parts.append('<ul class="bullets">')
                parts.extend(
                    f'<li><span class="b">{BULLET_GLYPH}</span>{_esc(b)}</li>'
                    for b in bullets
                )
                parts.append("</ul>")
            parts.append("</article>")

        parts.append("</section>")

    parts.append("</div></body></html>")
    return "".join(parts)


class RenderResult:
    """Outcome of one render. Never an exception."""

    __slots__ = ("ok", "pages", "reason", "path")

    def __init__(self, ok: bool, pages: int | None = None,
                 reason: str = "", path: str | None = None):
        self.ok = ok
        self.pages = pages
        self.reason = reason
        self.path = path

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"RenderResult(ok={self.ok}, pages={self.pages}, reason={self.reason!r})"


def renderer_available() -> bool:
    """True when Playwright and a Chromium build are both present."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def render(struct: dict, out_pdf: str, density: float = 1.0) -> RenderResult:
    """Render `struct` to `out_pdf`. Returns a RenderResult; never raises."""
    try:
        return _render(struct, out_pdf, density)
    except Exception as e:  # noqa: BLE001
        return RenderResult(False, reason=f"{type(e).__name__}: {e}")


def _render(struct: dict, out_pdf: str, density: float) -> RenderResult:
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:  # noqa: BLE001
        return RenderResult(False, reason=f"playwright unavailable: {e}")

    doc = build_html(struct, density)
    os.makedirs(os.path.dirname(os.path.abspath(out_pdf)) or ".", exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="grindly-render-") as tmp:
        src = os.path.join(tmp, "resume.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(doc)
        built = os.path.join(tmp, "resume.pdf")

        with sync_playwright() as p:
            browser = p.chromium.launch(
                args=[
                    # No sandbox: this runs in a container as root in production
                    # and the page is our own HTML with scripting off, so the
                    # sandbox buys nothing and costs a hard startup failure.
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                ],
            )
            try:
                context = browser.new_context(
                    java_script_enabled=False,   # the page has no scripts; make that enforceable
                    offline=True,                # nothing may be fetched, ever
                )
                page = context.new_page()
                page.goto(f"file://{src.replace(os.sep, '/')}",
                          wait_until="load", timeout=RENDER_TIMEOUT_MS)
                page.pdf(
                    path=built,
                    format=PAGE_FORMAT,
                    margin=MARGIN_MM,
                    print_background=False,
                    prefer_css_page_size=True,
                )
                context.close()
            finally:
                browser.close()

        if not os.path.exists(built) or os.path.getsize(built) == 0:
            return RenderResult(False, reason="chromium produced no output")

        pages = page_count(built)
        shutil.copyfile(built, out_pdf)
        return RenderResult(True, pages=pages, path=out_pdf)


def render_fitted(struct: dict, out_pdf: str, max_pages: int = MAX_PAGES) -> RenderResult:
    """Render, tightening leading once if the document overflows `max_pages`.

    One retry, not a search. A resume that is still three pages at 0.88 density
    is three pages of content, and squeezing further produces a document nobody
    can read — which is a worse outcome than reporting that it did not fit.
    """
    first = render(struct, out_pdf, density=1.0)
    if not first.ok:
        return first
    if first.pages is not None and first.pages > max_pages:
        tighter = render(struct, out_pdf, density=0.88)
        if tighter.ok:
            if tighter.pages is not None and tighter.pages > max_pages:
                tighter.reason = f"still {tighter.pages} pages after tightening"
            return tighter
    return first


def page_count(pdf_path: str) -> int | None:
    """Pages in a PDF, or None if it cannot be read."""
    try:
        from pdfminer.pdfpage import PDFPage

        with open(pdf_path, "rb") as f:
            return sum(1 for _ in PDFPage.get_pages(f))
    except Exception:  # noqa: BLE001
        try:
            import pypdf

            return len(pypdf.PdfReader(pdf_path).pages)
        except Exception:  # noqa: BLE001
            return None


def extract_back(pdf_path: str) -> str:
    """Read the rendered PDF back the way an ATS would.

    This closes the loop the whole product rests on: we do not assert that the
    rebuilt resume parses cleanly, we open it with the same extractor a parser
    uses and read what comes out. `resume_parse._pdf_text` is that extractor —
    pdfminer with a pypdf second opinion — so a variant is scored on exactly the
    text a machine recovers from it, never on the struct we meant to print.
    """
    try:
        import resume_parse

        return resume_parse.extract_text(pdf_path) or ""
    except Exception:  # noqa: BLE001
        return ""
