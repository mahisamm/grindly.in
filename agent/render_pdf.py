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
PAGE_FORMAT = "A4"
MARGIN_MM = {"top": "14mm", "right": "14mm", "bottom": "14mm", "left": "14mm"}

# A rebuilt one-page resume that spills to three pages is not an improvement, so
# the caller checks this and drops the variant.
MAX_PAGES = 2

RENDER_TIMEOUT_MS = int(os.environ.get("GRINDLY_RENDER_TIMEOUT_MS", "20000"))

# Chromium prints at 96 CSS px per inch regardless of the host's DPI setting, so
# a pt-based scale is stable across machines. Everything below is derived from
# BASE_PT to keep the vertical rhythm consistent when the caller tightens it.
BASE_PT = 10.0


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
    """
    base = BASE_PT
    return f"""
      @page {{ size: {PAGE_FORMAT}; margin: 0; }}
      * {{ box-sizing: border-box; }}
      html, body {{ margin: 0; padding: 0; }}
      body {{
        font-family: "Georgia", "Times New Roman", serif;
        font-size: {base}pt;
        line-height: {1.32 * density:.3f};
        color: #000000;
        background: #ffffff;
        -webkit-font-smoothing: antialiased;
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
        margin-bottom: {8 * density:.1f}pt;
        padding-bottom: {5 * density:.1f}pt;
        border-bottom: 0.8pt solid #000000;
      }}
      h1.name {{
        font-size: {base * 1.85:.1f}pt;
        font-weight: 700;
        letter-spacing: 0.02em;
        margin: 0 0 {3 * density:.1f}pt;
        line-height: 1.1;
      }}
      p.contact {{
        font-family: "Arial", "Helvetica", sans-serif;
        font-size: {base * 0.90:.1f}pt;
        margin: 0;
        line-height: 1.35;
        word-spacing: 0.02em;
      }}

      section.sec {{ margin-top: {8 * density:.1f}pt; }}
      h2.sec-h {{
        font-family: "Arial", "Helvetica", sans-serif;
        font-size: {base * 1.02:.1f}pt;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin: 0 0 {4 * density:.1f}pt;
        padding-bottom: {2 * density:.1f}pt;
        border-bottom: 0.5pt solid #000000;
        page-break-after: avoid;
      }}

      article.item {{
        margin-bottom: {5 * density:.1f}pt;
        page-break-inside: avoid;
      }}
      article.item:last-child {{ margin-bottom: 0; }}
      p.item-head {{
        font-size: {base * 1.03:.1f}pt;
        font-weight: 700;
        margin: 0;
        line-height: 1.25;
      }}
      p.item-sub {{
        font-family: "Arial", "Helvetica", sans-serif;
        font-size: {base * 0.88:.1f}pt;
        font-style: italic;
        margin: {1 * density:.1f}pt 0 0;
        line-height: 1.25;
      }}
      /* list-style is NONE and the glyph is real text inside the <li>. A CSS
         marker is generated content: it paints on the page and never reaches
         the text layer, so an extractor sees a wall of prose. Hanging indent
         via text-indent keeps the wrapped lines aligned under the text rather
         than under the bullet. */
      ul.bullets {{
        margin: {2.5 * density:.1f}pt 0 0;
        padding-left: 0;
        list-style: none;
      }}
      ul.bullets li {{
        margin: 0 0 {2 * density:.1f}pt;
        line-height: {1.30 * density:.3f};
        padding-left: {base * 1.15:.1f}pt;
        text-indent: -{base * 1.15:.1f}pt;
      }}
      ul.bullets li:last-child {{ margin-bottom: 0; }}
      ul.bullets li .b {{ padding-right: {base * 0.42:.1f}pt; }}

      p.skills-line {{ margin: 0 0 {2.5 * density:.1f}pt; line-height: 1.35; }}
      p.skills-line:last-child {{ margin-bottom: 0; }}
      p.skills-line b {{ font-weight: 700; }}
    """


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
        if contact:
            parts.append(f'<p class="contact">{_esc(contact)}</p>')
        parts.append("</header>")

    for sec in struct.get("sections") or []:
        heading = clean(sec.get("heading"))
        items = sec.get("items") or []
        if not heading and not items:
            continue
        parts.append('<section class="sec">')
        if heading:
            parts.append(f'<h2 class="sec-h">{_esc(heading)}</h2>')

        skills_like = bool(re.search(
            r"skill|tool|technolog|language|framework|competenc|stack|interest|hobb",
            heading, re.I,
        )) if heading else False

        for item in items:
            head = clean(item.get("head"))
            sub = clean(item.get("sub"))
            bullets = [clean(b) for b in (item.get("bullets") or [])]
            bullets = [b for b in bullets if b]

            if skills_like:
                # "Languages: Python, C++, SQL" on one line. A bulleted skills
                # list wastes a third of the page and reads worse.
                body = ", ".join(bullets)
                if head and body:
                    parts.append(f'<p class="skills-line"><b>{_esc(head)}:</b> {_esc(body)}</p>')
                elif head:
                    parts.append(f'<p class="skills-line">{_esc(head)}</p>')
                elif body:
                    parts.append(f'<p class="skills-line">{_esc(body)}</p>')
                continue

            parts.append('<article class="item">')
            if head:
                parts.append(f'<p class="item-head">{_esc(head)}</p>')
            if sub:
                parts.append(f'<p class="item-sub">{_esc(sub)}</p>')
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
