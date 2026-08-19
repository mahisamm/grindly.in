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

    struct = payload.get("struct")
    out = str(payload.get("out") or "")
    if not isinstance(struct, dict) or not out:
        return _fail("struct and out required")

    result = render_pdf.render_fitted(struct, out)
    if not result.ok:
        return _fail(f"render failed: {result.reason}")

    parsed = render_pdf.extract_back(out)
    return {
        "ok": True,
        "pages": result.pages,
        "chars": len(parsed.strip()),
        "report": readiness.score(parsed, _str_list(payload.get("target_keywords"))),
    }


def cmd_health(payload: dict) -> dict:
    """What this process can actually do, for /api/health and preflight."""
    import render_pdf

    checks = {"python": sys.version.split()[0], "renderer": render_pdf.renderer_available()}
    for mod in ("pdfminer.high_level", "pypdf", "docx", "sklearn"):
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


COMMANDS = {
    "ingest": cmd_ingest,
    "skills": cmd_skills,
    "report": cmd_report,
    "jd": cmd_jd,
    "companies": cmd_companies,
    "research": cmd_research,
    "variants": cmd_variants,
    "render": cmd_render,
    "health": cmd_health,
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
