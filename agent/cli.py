"""The one entry point the web app calls. JSON on stdin, JSON on stdout.

The previous build reached Python through a database-backed job queue: the web
app enqueued an `AgentRun`, a long-lived worker fleet drained it, and the
dashboard polled every 12 seconds waiting for a row to change. That architecture
existed because applying to a job board takes minutes and can fail halfway.
Reading a resume takes seconds and either works or doesn't, so the queue is now
pure cost: two extra processes to run, a polling UI, and a class of bug where a
job is claimed and never finished.

This is a plain subprocess. Next spawns it, writes one JSON object to stdin,
reads one JSON object from stdout, and the process exits. No database, no queue,
no shared state, no long-lived worker. Python here is a pure function of its
input, which also means it is trivial to test from a shell:

    echo '{"cmd":"report","text":"..."}' | python agent/cli.py

CONTRACT, and it is absolute: this program prints exactly one JSON object to
stdout and exits 0, for every input, including malformed input and internal
crashes. Failures are reported as `{"ok": false, "error": ...}`, never as a
traceback and never as a non-zero exit with an empty pipe — the caller must
never have to distinguish "Python is missing" from "the resume was unreadable"
by parsing stderr. Diagnostics go to stderr, where they land in the server log
and can never corrupt the payload.
"""
from __future__ import annotations

import json
import os
import re
import sys
import traceback

# UTF-8 on the pipes, unconditionally, before anything can write to them.
#
# Python picks stdout's encoding from the locale, and on Windows that is the
# ANSI codepage — cp1252 on an ordinary machine. This program's contract is one
# JSON object on stdout and the caller decodes it as UTF-8, so every character
# above ASCII in a finding, a fix line or a company summary was being written as
# a cp1252 byte and read back as a broken one. It showed up in the product as a
# replacement character mid-sentence: "not just the word 'GitHub' behind a
# hyperlink <?> extractors read text, not link annotations" — on the readiness
# report, which is the screen the whole product is built around.
#
# Linux hides this: with no locale set, Python 3.7+ coerces to C.UTF-8 and
# everything happens to work, so the container was fine and every developer on
# Windows was reading corrupted output. Naming the encoding costs two lines and
# makes development and production agree.
#
# stdin too: a resume pasted through this pipe carries accented names and
# rupee signs, and decoding those as cp1252 mangles them on the way in.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):  # pragma: no cover - already wrapped
        pass

# Every sibling module imports its peers by bare name (`import llm`), which only
# resolves when this directory is on the path. Running `python agent/cli.py`
# from the repo root puts the SCRIPT's directory on sys.path automatically, but
# `python -m agent.cli` and an embedded call do not — so make it explicit rather
# than depending on how we happened to be invoked.
_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# Anything printed to stdout by an imported module would corrupt the one JSON
# object this program is contracted to emit — and the resume pipeline prints
# progress lines liberally (`[optimize] baseline = 71`). Rather than hunt them
# all down, stdout is swapped for stderr during the work and restored only to
# write the result.
_REAL_STDOUT = sys.stdout

MAX_TEXT = 60000


def _fail(error: str, **extra) -> dict:
    return {"ok": False, "error": error, **extra}


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------

def cmd_ingest(payload: dict) -> dict:
    """Read a resume file into text plus the contact details on its header."""
    import resume_ai
    import resume_parse

    path = str(payload.get("path") or "")
    if not path or not os.path.exists(path):
        return _fail("file not found")

    text = resume_parse.extract_text(path) or ""
    links = resume_parse.pdf_links(path)
    contact: dict = {}
    try:
        contact = resume_ai.extract_contact(text) or {}
    except Exception as e:  # noqa: BLE001
        print(f"[cli] contact extraction failed: {e}", file=sys.stderr)

    # `chars` counts the WHOLE document; `text` is capped. Those two disagreeing
    # is the only signal that anything was dropped, and the caller should not
    # have to rediscover the constant to work it out — a resume longer than the
    # cap is scored, rewritten and fidelity-checked on a fragment, and the
    # product has to be able to say so.
    return {
        "ok": True,
        "text": text[:MAX_TEXT],
        "chars": len(text.strip()),
        "truncated": len(text) > MAX_TEXT,
        "links": links[:12],
        "contact": contact,
    }


def cmd_skills(payload: dict) -> dict:
    """Extract the candidate's own skills from their resume text."""
    import resume_parse

    text = str(payload.get("text") or "")[:MAX_TEXT]
    return {"ok": True, "skills": resume_parse.extract_skills(text)}


def cmd_report(payload: dict) -> dict:
    """The readiness report: the score, the bands, the findings.

    `advice` is included only when `with_advice` is set, because it is the one
    part of this command that costs an LLM call and takes seconds rather than
    milliseconds. The score never does.
    """
    import readiness

    text = str(payload.get("text") or "")[:MAX_TEXT]
    skills = _str_list(payload.get("target_keywords"))
    report = readiness.score(text, skills)

    if payload.get("with_advice"):
        import resume_ai
        try:
            report["advice"] = resume_ai.advise(text)
        except Exception as e:  # noqa: BLE001
            print(f"[cli] advise failed: {e}", file=sys.stderr)
            report["advice"] = None

    return {"ok": True, "report": report}


def cmd_jd(payload: dict) -> dict:
    """Parse a pasted job description into requirements."""
    import jobspec

    text = str(payload.get("text") or "")
    spec = jobspec.parse(text, use_llm=bool(payload.get("use_llm", True)))
    return {"ok": True, "spec": spec}


def cmd_companies(payload: dict) -> dict:
    """The curated company packs, or one of them."""
    import companies

    slug = str(payload.get("slug") or "").strip()
    if slug:
        pack = companies.get_pack(slug)
        if not pack:
            return _fail("unknown company")
        return {"ok": True, "pack": pack, "disclaimer": companies.DISCLAIMER}
    query = str(payload.get("q") or "")
    return {
        "ok": True,
        "packs": companies.search(query) if query else companies.list_packs(),
        "disclaimer": companies.DISCLAIMER,
    }


def cmd_research(payload: dict) -> dict:
    """Target a company that has no curated pack.

    Returns one of three honest answers — a curated pack, a clearly-labelled
    generated one, or "tailoring is not required here and this is why". See
    company_research.py; the interesting work is in deciding to decline.
    """
    import company_research

    return company_research.research(
        str(payload.get("name") or ""),
        str(payload.get("role") or "")[:120],
    )


def cmd_variants(payload: dict) -> dict:
    """Build up to three measured rewrites and write their PDFs to `out_dir`.

    PDF bytes are written to disk and referenced by filename rather than
    base64'd into this response. A three-variant batch is ~300 KB of PDF; base64
    inflates that by a third and forces the whole payload through a pipe, a JSON
    parser, and a Node string before anything can be shown. The web app already
    has a filesystem it shares with this process.
    """
    import resume_optimize

    text = str(payload.get("text") or "")[:MAX_TEXT]
    skills = _str_list(payload.get("skills"))
    target_keywords = _str_list(payload.get("target_keywords"))
    emphasis = _str_list(payload.get("emphasis"))
    target_name = str(payload.get("target_name") or "")[:120]
    out_dir = str(payload.get("out_dir") or "")
    if not out_dir:
        return _fail("out_dir required")
    os.makedirs(out_dir, exist_ok=True)

    result = resume_optimize.generate_variants(
        text,
        skills,
        contact_fallback=str(payload.get("contact_fallback") or ""),
        target_keywords=target_keywords,
        emphasis=emphasis,
        target_name=target_name,
        # The PDF's link annotations, from `ingest`. A resume that shows the
        # word "LinkedIn" behind a hyperlink carries an address no text
        # extractor sees — printing it as text is how the rebuild stops losing it.
        source_links=_str_list(payload.get("links"), limit=24),
        link_style=str(payload.get("link_style") or "url"),
    )

    written = []
    for i, v in enumerate(result.get("variants") or []):
        pdf_bytes = v.pop("pdf_bytes", None)
        if not pdf_bytes:
            continue
        name = f"variant-{i + 1}.pdf"
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(pdf_bytes)
        v["file"] = name
        v["bytes"] = len(pdf_bytes)
        written.append(v)

    result["variants"] = written
    return {"ok": True, **result}


def cmd_render(payload: dict) -> dict:
    """Render a struct straight to PDF. Used by 'build from scratch'."""
    import readiness
    import render_pdf

    import resume_optimize

    struct = payload.get("struct")
    out = str(payload.get("out") or "")
    if not isinstance(struct, dict) or not out:
        return _fail("struct and out required")

    # Sanitised before anything is printed. This used to be reachable only from
    # our own pipeline, whose structs were already sanitised on the way out of
    # the model; it is now also reachable from the editor, which means the shape
    # arrives from a browser. _sanitize_struct is what turns "bullets" that came
    # through as a plain string into a list — without it that string is iterated
    # character by character and the PDF gets one bullet per letter.
    struct = resume_optimize._sanitize_struct(struct)
    if not struct or not struct.get("sections"):
        return _fail("that structure has no content to render")

    # How profile addresses are printed. Carried on the struct rather than as a
    # separate render argument, because it is a property of the document and
    # every path that renders one — this command and the variant pipeline —
    # needs it to travel with the thing being printed.
    if payload.get("link_style") in ("url", "label"):
        struct["link_style"] = payload["link_style"]

    result = render_pdf.render_fitted(struct, out)
    if not result.ok:
        return _fail(f"render failed: {result.reason}")

    parsed = render_pdf.extract_back(out)
    return {
        "ok": True,
        "pages": result.pages,
        "chars": len(parsed.strip()),
        # The reading itself, not only its length. `chars` answers "did anything
        # come out"; `text` is what the score was computed from, and it is what a
        # caller needs to store if this document is ever to become a resume of
        # its own. Reading the PDF back a second time later would be a second
        # extraction of the same file to recover something already in hand.
        "text": parsed,
        "report": readiness.score(parsed, _str_list(payload.get("target_keywords"))),
    }



def _strip_redaction_markers(value):
    """Remove the placeholders redact.py substitutes on the way OUT of here.

    A model is handed a prompt whose email and phone have already been replaced
    by `[email redacted]` and `[phone redacted]`, and when asked to reproduce a
    contact line it faithfully copies the placeholders back. Written into a
    resume, they become a document that reaches an employer saying
    "[email redacted]" where the address should be.

    Applied to the WHOLE structure rather than only the contact line, because
    an ID run inside a bullet ("employee ID 44210") is redacted by the same
    pass.
    """
    import redact

    markers = (redact.EMAIL_PLACEHOLDER, redact.PHONE_PLACEHOLDER, redact.ID_PLACEHOLDER)

    if isinstance(value, str):
        out = value
        for marker in markers:
            out = out.replace(marker, "")
        # Separators left stranded by a removal: " | | Bengaluru" -> "Bengaluru".
        out = re.sub(r"\s*([|,·•])\s*(?=[|,·•])", "", out)
        out = re.sub(r"^\s*[|,·•]\s*|\s*[|,·•]\s*$", "", out)
        return re.sub(r"[ \t]{2,}", " ", out).strip()
    if isinstance(value, list):
        return [_strip_redaction_markers(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip_redaction_markers(v) for k, v in value.items()}
    return value


def cmd_struct(payload: dict) -> dict:
    """Read a resume into the editable structure the renderer prints.

    Same extraction the rewrite pipeline runs on every batch, exposed on its own
    so the web app can hand a user their resume as fields rather than as a wall
    of extracted text. That is the difference between a tool that tells you what
    is missing and one you can fix it in.

    Costs model calls, so callers cache the result on the resume row rather than
    asking again on every page load.
    """
    import resume_optimize

    text = str(payload.get("text") or "")[:MAX_TEXT]
    if len(text.strip()) < 200:
        return _fail("too little text to read a structure from")

    struct = resume_optimize._extract_struct(text)
    if not struct:
        return _fail("could not read a structure from this resume")

    struct = _strip_redaction_markers(struct)

    # IDENTITY COMES FROM THE SOURCE, NOT FROM THE MODEL — via the same function
    # the rewrite path uses, which is why that path never had this bug.
    #
    # `_identity_from_source` reads the name and contact line off the RAW resume
    # text, before redaction, and its own docstring says why: everything a model
    # returns for these two fields is placeholder text, because the LLM boundary
    # replaced the email and phone before the prompt left this process.
    #
    # Two earlier versions of this were wrong, both found by testing the live
    # site. The first applied a fallback only when the model returned nothing —
    # but it returns something, it is just wrong, so the fallback never fired and
    # production handed back "[email redacted] | [phone redacted] | Bengaluru".
    # The second stamped the caller's `contact_fallback`, which is always empty:
    # it comes from `resume_ai.extract_contact`, which returns name/phone/gpa/urls
    # and has no `contact_line` key at all — so the header came back with the
    # email and phone simply missing instead.
    #
    # Calling the proven function deletes the second implementation rather than
    # fixing it again.
    name, contact_line = resume_optimize._identity_from_source(
        text,
        str(payload.get("contact_fallback") or ""),
        _str_list(payload.get("links"), limit=24),
    )
    if name:
        struct["name"] = name
    if contact_line:
        struct["contact_line"] = contact_line

    return {"ok": True, "struct": struct}


def cmd_export(payload: dict) -> dict:
    """The same resume as .docx or as plain text.

    docx comes back base64-encoded rather than written to a path, because unlike
    a variant batch this is one small file produced on demand for an immediate
    download — there is nothing to name it after and nothing to clean up.
    """
    import base64

    import render_docx
    import resume_optimize

    struct = payload.get("struct")
    if not isinstance(struct, dict):
        return _fail("struct required")

    struct = resume_optimize._sanitize_struct(struct)
    if not struct or not struct.get("sections"):
        return _fail("that structure has no content to export")

    fmt = str(payload.get("format") or "docx").lower()
    if fmt == "txt":
        return {"ok": True, "format": "txt", "text": render_docx.build_text(struct)}
    if fmt == "docx":
        data = render_docx.build_docx(struct)
        return {
            "ok": True,
            "format": "docx",
            "bytes": len(data),
            "base64": base64.b64encode(data).decode("ascii"),
        }
    return _fail(f"unknown format: {fmt}")



def cmd_cover(payload: dict) -> dict:
    """A cover letter, under the same rules as everything else here.

    See cover_letter.py: the gates are stricter than the resume's, because a
    cover letter is prose ABOUT the candidate rather than a rearrangement of
    what they wrote, and the genre is built out of exactly the claims they
    cannot defend.
    """
    import cover_letter

    result = cover_letter.write(
        str(payload.get("text") or "")[:MAX_TEXT],
        company=str(payload.get("company") or "")[:120],
        role=str(payload.get("role") or "")[:120],
        requirements=_str_list(payload.get("requirements"), limit=20),
    )

    # A refusal is reported as a SUCCESSFUL call that produced no letter, the
    # same shape `variants` uses for `aborted`. The distinction matters on the
    # other side of the pipe: lib/agent.ts records every {ok:false} as an error
    # event, and "the drafts all made claims the resume does not support" is a
    # product outcome rather than a fault. Filing it as one would bury the real
    # faults under it.
    if result.get("ok"):
        return {"ok": True, "refused": None, "letter": result["letter"],
                "used": result.get("used") or []}
    return {
        "ok": True,
        "refused": result.get("error") or "No letter could be produced.",
        "problems": result.get("problems") or [],
        "letter": "",
        "used": [],
    }


def cmd_health(payload: dict) -> dict:
    """What this process can actually do, for /api/health and preflight."""
    import render_pdf

    checks = {"python": sys.version.split()[0], "renderer": render_pdf.renderer_available()}
    # What this process needs to do its job. `sklearn` used to be on this list
    # and was neither imported by anything nor installed after the pivot — a
    # health check reporting on a package the product does not use is a health
    # check nobody reads carefully.
    for mod in ("pdfminer.high_level", "pypdf", "docx"):
        try:
            __import__(mod)
            checks[mod.split(".")[0]] = True
        except Exception:  # noqa: BLE001
            checks[mod.split(".")[0]] = False
    try:
        import llm as llm_mod
        checks["llm_providers"] = [
            p.name for p in llm_mod.PROVIDERS if os.environ.get(p.key_env)
        ]
    except Exception:  # noqa: BLE001
        checks["llm_providers"] = []
    return {"ok": True, "checks": checks}


def cmd_classify_feedback(payload: dict) -> dict:
    """Sentiment and a one-line summary for one problem report.

    Single-provider (llm.chat_json), not the ensemble: this sorts an admin's
    inbox into two columns, not a candidate's resume score — a majority-vote
    merge across three providers is not worth three times the cost for
    "positive or negative".
    """
    import llm

    message = str(payload.get("message") or "").strip()[:4000]
    if len(message) < 3:
        return _fail("message is empty")

    def valid(parsed: object) -> bool:
        return (
            isinstance(parsed, dict)
            and parsed.get("sentiment") in ("positive", "negative")
            and isinstance(parsed.get("summary"), str)
            and bool(parsed["summary"].strip())
        )

    result = llm.chat_json(
        "A user of a resume-tailoring product wrote this in the app's feedback "
        f'widget:\n\n"""\n{message}\n"""\n\n'
        "Reply with ONLY a JSON object: "
        '{"sentiment": "positive" | "negative", '
        '"summary": "<one line, under 100 characters, in your own words>"}. '
        'Choose "negative" for anything reporting a bug, a complaint, confusion, '
        "or a request that implies something is missing or broken. Choose "
        '"positive" only for genuine praise or a thank-you with no complaint in '
        'it. When in doubt, choose "negative" — this feeds a queue of things to '
        "fix, not a testimonial wall.",
        system="You classify one piece of user feedback. Reply with strict JSON and nothing else.",
        validator=valid,
    )
    if not result:
        return _fail("no provider returned a usable classification")

    return {
        "ok": True,
        "sentiment": result["sentiment"],
        "summary": result["summary"].strip()[:200],
    }


COMMANDS = {
    "ingest": cmd_ingest,
    "skills": cmd_skills,
    "report": cmd_report,
    "jd": cmd_jd,
    "companies": cmd_companies,
    "research": cmd_research,
    "variants": cmd_variants,
    "struct": cmd_struct,
    "render": cmd_render,
    "export": cmd_export,
    "cover": cmd_cover,
    "health": cmd_health,
    "classify_feedback": cmd_classify_feedback,
}


def _str_list(value: object, limit: int = 60) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value[:limit] if str(v).strip()]


def main(argv: list[str]) -> int:
    raw = sys.stdin.read()
    # A UTF-8 BOM on stdin is not valid JSON and json.loads says so in a message
    # that reads like a bug in the caller. Windows shells add one freely (any
    # PowerShell pipe does), and so do some editors, so a developer testing this
    # by hand hits it before they hit anything real. Stripping it costs one line.
    raw = raw.lstrip("﻿")
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as e:
        _emit(_fail(f"invalid JSON on stdin: {e}"))
        return 0

    if not isinstance(payload, dict):
        _emit(_fail("payload must be a JSON object"))
        return 0

    cmd = str(payload.get("cmd") or (argv[1] if len(argv) > 1 else "")).strip()
    handler = COMMANDS.get(cmd)
    if not handler:
        _emit(_fail(f"unknown command {cmd!r}", commands=sorted(COMMANDS)))
        return 0

    # From here until the result is written, anything a module prints goes to
    # the log, not into the payload.
    sys.stdout = sys.stderr
    try:
        result = handler(payload)
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        result = _fail(f"{type(e).__name__}: {e}")
    finally:
        sys.stdout = _REAL_STDOUT

    _emit(result)
    return 0


def _emit(obj: dict) -> None:
    try:
        text = json.dumps(obj, ensure_ascii=False, default=str)
    except Exception as e:  # noqa: BLE001
        text = json.dumps(_fail(f"result was not serialisable: {e}"))
    _REAL_STDOUT.write(text)
    _REAL_STDOUT.flush()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
