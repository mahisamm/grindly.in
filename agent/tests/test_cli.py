"""The JSON-in / JSON-out contract, exercised as a real subprocess.

Every test here spawns `agent/cli.py` the way the web app does, because the
things that break at this boundary — stream encoding, a BOM on stdin, a module
printing to stdout, a crash — are invisible when the functions are called
in-process.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

CLI = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cli.py")


def run(payload: object, *, env_extra: dict | None = None, raw: bytes | None = None):
    """Spawn the CLI and return (parsed_json, stderr_text).

    PYTHONIOENCODING and PYTHONUTF8 are explicitly REMOVED from the child's
    environment. The app sets them, but the point of these tests is that the
    contract holds without them — a developer running `python agent/cli.py` by
    hand, a cron job, or any caller that forgets.
    """
    env = dict(os.environ)
    env.pop("PYTHONIOENCODING", None)
    env.pop("PYTHONUTF8", None)
    env.update(env_extra or {})

    data = raw if raw is not None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    proc = subprocess.run(
        [sys.executable, CLI], input=data, capture_output=True, env=env, timeout=180,
    )
    assert proc.returncode == 0, (
        f"the CLI must always exit 0; got {proc.returncode}\n"
        f"stderr: {proc.stderr.decode('utf-8', 'replace')[-800:]}"
    )
    text = proc.stdout.decode("utf-8")  # deliberately strict — see test below
    return json.loads(text), proc.stderr.decode("utf-8", "replace")


# ---------------------------------------------------------------------------
# encoding
# ---------------------------------------------------------------------------

def test_stdout_is_utf8_regardless_of_the_hosts_locale():
    """The bug this file was written for.

    Python takes stdout's encoding from the locale. On Windows that is the ANSI
    codepage, so the em dash in a finding's fix line was written as a cp1252
    byte and decoded by Node as UTF-8 — producing a replacement character in
    the middle of a sentence on the readiness report, which is the screen the
    entire product is built around. Linux hid it completely.
    """
    out, _ = run({"cmd": "report", "text": "Priya Sharma\nEDUCATION\nB.E.\nEXPERIENCE\nIntern"})
    assert out["ok"] is True
    blob = json.dumps(out, ensure_ascii=False)
    assert "�" not in blob, "the CLI emitted a replacement character"
    assert "—" in blob, "the em dashes in the findings did not survive the pipe"


def test_non_ascii_input_survives_the_round_trip():
    """A name with an accent, a rupee amount, a middot separator."""
    text = (
        "Raménathan Krishnamürthy\n"
        "+91 90000 00000 · rame@example.com · linkedin.com/in/rame\n"
        "EXPERIENCE\nAnalyst, Acme | Jan 2020 - Present\n"
        "• Cut spend by ₹4,50,000 a year across 12 vendors\n"
        "EDUCATION\nB.Com, Delhi University | 2016 - 2019\n"
        "TECHNICAL SKILLS\nExcel, SQL\n"
    )
    out, _ = run({"cmd": "report", "text": text})
    assert out["ok"] is True
    # The rupee figure is a quantity, so it must have been seen as one.
    assert out["report"]["facts"]["impact"]["quantified"] >= 1


def test_a_utf8_bom_on_stdin_is_not_a_parse_error():
    """Any PowerShell pipe adds one, and json.loads reports it as a bug in the
    caller rather than as the invisible byte it is."""
    body = json.dumps({"cmd": "companies"}).encode("utf-8")
    out, _ = run(None, raw=b"\xef\xbb\xbf" + body)
    assert out["ok"] is True
    assert len(out["packs"]) >= 10


# ---------------------------------------------------------------------------
# the contract: one JSON object, exit 0, always
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw", [
    b"",
    b"   ",
    b"not json at all",
    b"[1, 2, 3]",
    b'{"cmd": 12345}',
    b'{"cmd": "does-not-exist"}',
    b'{"no cmd here": true}',
])
def test_bad_input_produces_json_not_a_traceback(raw):
    out, _ = run(None, raw=raw)
    assert isinstance(out, dict)
    assert "ok" in out
    if out["ok"] is False:
        assert isinstance(out["error"], str) and out["error"]


def test_module_chatter_never_reaches_stdout():
    """The pipeline prints progress lines liberally ("[optimize] baseline = 71").

    One of those on stdout corrupts the single JSON object this program is
    contracted to emit, so stdout is swapped for stderr while the work runs.
    """
    out, err = run({"cmd": "report", "text": "Priya\nEDUCATION\nB.E.\nEXPERIENCE\nIntern at Acme"})
    assert out["ok"] is True
    # The report command is quiet, but the swap must still be in force: nothing
    # other than the JSON object may appear on stdout, and this asserts the
    # parse succeeded on the whole stream rather than on a prefix of it.
    assert set(out) >= {"ok", "report"}


def test_missing_file_is_reported_not_raised():
    out, _ = run({"cmd": "ingest", "path": "/definitely/not/here.pdf"})
    assert out == {"ok": False, "error": "file not found"}


def test_render_requires_its_arguments():
    out, _ = run({"cmd": "render", "struct": {"name": "X"}})
    assert out["ok"] is False
    assert "out" in out["error"]


def test_health_reports_what_this_process_can_do():
    out, _ = run({"cmd": "health"})
    assert out["ok"] is True
    checks = out["checks"]
    assert checks["python"].startswith("3.")
    for key in ("renderer", "pdfminer", "pypdf", "llm_providers"):
        assert key in checks, key
