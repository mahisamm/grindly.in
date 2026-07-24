"""Edit a candidate's own LaTeX resume in place, and recompile it.

The whole point of this module is what it REFUSES to do. The user's template is
mandated by their college — fixed sections, fixed order, fixed geometry. So the
agent is never handed the document; it is handed two specific section bodies
(Skills, Hobbies) and may replace only those. Everything else — preamble,
geometry, fonts, section order, Education, Experience, Projects — is spliced
back byte-for-byte from the original source.

That is why this exists instead of the old path, which rendered a brand-new PDF
from plain text via fpdf2 and produced exactly the "looks patched" output the
template rules are meant to prevent.

Public API:
    find_tex(uid)                    -> path | None
    editable_sections(tex)           -> {"skills": Section, "hobbies": Section}
    replace_bodies(tex, edits)       -> str
    compile_pdf(tex_source, out_pdf) -> bool
    compile_report(tex_source, pdf)  -> CompileResult   (ok, pages, overfull)
    page_count(pdf)                  -> int | None
    unsafe_commands(tex)             -> list[str]
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

TEX_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "resume_tex")

# Compile timeout. A first-ever Tectonic run downloads the packages the document
# needs, so the cold path is genuinely slow; every subsequent compile is ~2s off
# the cache volume. Generous, but bounded — a LaTeX document can loop forever.
COMPILE_TIMEOUT_SEC = int(os.environ.get("GRINDLY_LATEX_TIMEOUT", "180"))


# --- security ---------------------------------------------------------------
# We compile a file the user uploaded, on our server. LaTeX is a programming
# language with filesystem and (with shell-escape) shell access, so an uploaded
# .tex is untrusted input in the strongest sense.
#
# Defence is two-layer, because neither layer alone is enough:
#   1. `tectonic --untrusted` — refuses shell-escape and blocks reads outside the
#      document's own directory. This is the real boundary.
#   2. The denylist below — rejects the document before we ever hand it to
#      Tectonic. Redundant with (1) on purpose: it fails closed if someone later
#      drops --untrusted, and it gives the user a clear error instead of a
#      confusing compiler failure.
_UNSAFE = [
    r"\\write18",          # shell escape
    r"\\immediate\s*\\write18",
    r"\\input\s*\{\s*/",   # absolute-path read (\input{/etc/passwd})
    r"\\include\s*\{\s*/",
    r"\\openin",           # file read
    r"\\openout",          # file write
    r"\\read\b",
    r"\\catcode",          # can re-define the escape char to smuggle the above
    r"\\directlua",        # LuaTeX arbitrary code
    r"\\ShellEscape",
]


def unsafe_commands(tex: str) -> list[str]:
    """LaTeX constructs we refuse to compile. Empty list = safe to hand to Tectonic."""
    found: list[str] = []
    for pat in _UNSAFE:
        if re.search(pat, tex, re.I):
            found.append(pat.replace("\\\\", "\\").replace(r"\s*", "").replace(r"\b", ""))
    return found


# --- section model ----------------------------------------------------------

@dataclass
class Section:
    """A section the agent is allowed to rewrite. `start`/`end` bracket the BODY
    only — the \\section{...} heading itself is outside the span and can never be
    touched, so the heading text, its order, and its position on the page survive
    any edit."""
    name: str        # heading text as written, e.g. "Technical Skills"
    slot: str        # normalised bucket: "skills" | "hobbies"
    start: int       # index of first char of the body
    end: int         # index one past the last char of the body

    def body(self, tex: str) -> str:
        return tex[self.start:self.end]


# Only these two buckets are editable. Adding to this map is the ONLY way to
# widen what the agent may rewrite — deliberately a single choke point.
_SLOTS: dict[str, set[str]] = {
    "skills": {
        "skills", "technical skills", "technical skill", "skill",
        "core skills", "key skills", "tech stack", "technologies",
        "skills summary", "technical proficiencies", "areas of expertise",
    },
    "hobbies": {
        "hobbies", "interests", "hobbies and interests", "hobbies & interests",
        "extra curricular activities", "extracurricular activities",
        "activities", "personal interests",
    },
}

# Matches \section{X}, \section*{X}, and the \resumeSection{X}/\cvsection{X}
# macros that most college templates define over \section.
_HEADING = re.compile(
    r"\\(?:section|subsection|resumesection|cvsection|rSection)\*?\s*\{([^}]*)\}",
    re.I,
)


def _norm_heading(s: str) -> str:
    """Strip LaTeX formatting macros out of a heading so "\\textbf{Skills}" and
    "SKILLS" both land in the same bucket."""
    s = re.sub(r"\\[a-zA-Z]+", " ", s)          # \textbf, \Large, ...
    s = re.sub(r"[^a-zA-Z& ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s


def _slot_for(heading: str) -> str | None:
    h = _norm_heading(heading)
    for slot, names in _SLOTS.items():
        if h in names:
            return slot
    return None


def sections(tex: str) -> list[Section]:
    """Every heading in the document, with the byte span of its body.

    A section's body runs from the end of its heading to the start of the next
    heading — or to \\end{document} for the last one, so we never swallow the
    document terminator into an editable span.
    """
    heads = list(_HEADING.finditer(tex))
    if not heads:
        return []

    doc_end = tex.find(r"\end{document}")
    if doc_end < 0:
        doc_end = len(tex)

    out: list[Section] = []
    for i, m in enumerate(heads):
        body_start = m.end()
        body_end = heads[i + 1].start() if i + 1 < len(heads) else doc_end
        if body_end < body_start:
            continue
        slot = _slot_for(m.group(1))
        out.append(
            Section(
                name=m.group(1).strip(),
                slot=slot or "",
                start=body_start,
                end=body_end,
            )
        )
    return out


def editable_sections(tex: str) -> dict[str, Section]:
    """The Skills/Hobbies sections, keyed by slot. Missing slots are simply
    absent — a resume with no Hobbies section is normal, not an error.

    If a template somehow declares the same slot twice, the FIRST wins; rewriting
    both would be a way to smuggle a second edit past the reviewer's eye.
    """
    found: dict[str, Section] = {}
    for s in sections(tex):
        if s.slot and s.slot not in found:
            found[s.slot] = s
    return found


def replace_bodies(tex: str, edits: dict[str, str]) -> str:
    """Splice new bodies into the editable sections. Everything outside those
    spans is preserved character-for-character.

    Applied back-to-front so that each splice cannot invalidate the offsets of
    the ones still to come.
    """
    editable = editable_sections(tex)
    targets = [
        (editable[slot], body)
        for slot, body in edits.items()
        if slot in editable and body is not None
    ]
    targets.sort(key=lambda t: t[0].start, reverse=True)

    out = tex
    for sec, new_body in targets:
        out = out[: sec.start] + new_body + out[sec.end:]
    return out


# --- compile ----------------------------------------------------------------

# "Overfull \hbox" / "Overfull \vbox" — LaTeX's report that a line ran past the
# right margin or a block ran past the bottom. It's the misalignment a page-count
# check can't see: the page total is unchanged, but text is visibly spilling out
# of the column. This is the signal an edit "isn't neat".
_OVERFULL = re.compile(r"Overfull \\[hv]box", re.I)


@dataclass
class CompileResult:
    """A compile outcome plus the two signals that decide whether an edit stayed
    neat: the page count, and the number of Overfull boxes LaTeX reported. A caller
    accepts a tailored resume only when the page count matches the master AND the
    edit added no new overfull boxes."""
    ok: bool
    pages: int | None = None
    overfull: int = 0


def tectonic_available() -> bool:
    return shutil.which("tectonic") is not None


def _count_overfull(workdir: str, proc: "subprocess.CompletedProcess") -> int:
    """How many Overfull \\hbox/\\vbox LaTeX reported for this build.

    The .log (kept via --keep-logs) is authoritative — LaTeX records every
    overfull box there regardless of how quiet the console is. The captured
    stdout/stderr is only a fallback if no log was written.
    """
    text = ""
    try:
        for name in os.listdir(workdir):
            if name.endswith(".log"):
                with open(os.path.join(workdir, name), encoding="utf-8", errors="ignore") as f:
                    text += f.read()
    except OSError:
        pass
    if not text:
        text = (proc.stderr or "") + (proc.stdout or "")
    return len(_OVERFULL.findall(text))


def compile_report(tex_source: str, out_pdf: str) -> CompileResult:
    """Compile LaTeX to `out_pdf` and report page count + overfull-box count.

    Never raises — a resume that won't build must degrade to sending the master
    PDF, not blow up the run. On any failure returns CompileResult(ok=False).

    "Never raises" was a claim, not a guarantee: the subprocess call was guarded
    but the filesystem work around it was not. A full disk or an unwritable
    output directory raised OSError out of tempfile / open / makedirs /
    copyfile, past the caller in worker._get_resume, and killed the entire run —
    for a resume tailoring that the caller was fully prepared to skip. The
    fallback is always the master PDF, so nothing here is worth a run.
    """
    try:
        return _compile_report(tex_source, out_pdf)
    except Exception as e:  # noqa: BLE001
        print(f"[latex] compile aborted: {type(e).__name__}: {e}")
        return CompileResult(False)


def _compile_report(tex_source: str, out_pdf: str) -> CompileResult:
    bad = unsafe_commands(tex_source)
    if bad:
        print(f"[latex] refusing to compile — unsafe command(s): {bad}")
        return CompileResult(False)

    if not tectonic_available():
        print("[latex] tectonic not installed — cannot compile; see Dockerfile.worker")
        return CompileResult(False)

    with tempfile.TemporaryDirectory(prefix="grindly-tex-") as tmp:
        src = os.path.join(tmp, "resume.tex")
        with open(src, "w", encoding="utf-8") as f:
            f.write(tex_source)
        try:
            proc = subprocess.run(
                [
                    "tectonic",
                    "--untrusted",     # no shell-escape, no reads outside `tmp`
                    "--keep-logs",     # keep resume.log so we can read overfull warnings
                    "--chatter", "minimal",
                    "--outdir", tmp,
                    src,
                ],
                capture_output=True,
                text=True,
                timeout=COMPILE_TIMEOUT_SEC,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            print(f"[latex] compile timed out after {COMPILE_TIMEOUT_SEC}s")
            return CompileResult(False)
        except OSError as e:
            print(f"[latex] compile could not start: {e}")
            return CompileResult(False)

        built = os.path.join(tmp, "resume.pdf")
        if proc.returncode != 0 or not os.path.exists(built):
            tail = (proc.stderr or proc.stdout or "")[-500:]
            print(f"[latex] compile failed (rc={proc.returncode}): {tail}")
            return CompileResult(False)

        overfull = _count_overfull(tmp, proc)
        pages = page_count(built)
        os.makedirs(os.path.dirname(os.path.abspath(out_pdf)), exist_ok=True)
        shutil.copyfile(built, out_pdf)
        return CompileResult(True, pages=pages, overfull=overfull)


def compile_pdf(tex_source: str, out_pdf: str) -> bool:
    """Back-compat boolean wrapper around compile_report — used by the upload-time
    self-test, which only needs to know whether the untouched .tex builds at all."""
    return compile_report(tex_source, out_pdf).ok


def page_count(pdf_path: str) -> int | None:
    """Page count, or None if it can't be read. Used as the layout tripwire: an
    edit that changes the page count has reflowed the document, which is exactly
    the breakage the college template rules exist to prevent."""
    try:
        from pdfminer.pdfpage import PDFPage

        with open(pdf_path, "rb") as f:
            return sum(1 for _ in PDFPage.get_pages(f))
    except Exception as e:  # noqa: BLE001
        print(f"[latex] page_count failed: {e}")
        return None


# --- storage ----------------------------------------------------------------

def find_tex(uid: str) -> str | None:
    """The user's uploaded LaTeX source, if they gave us one.

    Kept in its own directory, NOT alongside the PDF in data/resumes/ — that
    directory is scanned by resume_parse.find_resume_file(), which matches on
    "<uid>." and would happily hand a .tex to the PDF text extractor.
    """
    path = os.path.join(TEX_DIR, f"{uid}.tex")
    return path if os.path.exists(path) else None


def read_tex(uid: str) -> str:
    path = find_tex(uid)
    if not path:
        return ""
    try:
        with open(path, encoding="utf-8", errors="ignore") as f:
            return f.read()
    except OSError as e:
        print(f"[latex] could not read {path}: {e}")
        return ""
