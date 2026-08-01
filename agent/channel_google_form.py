"""Google Forms application channel — read the form, answer it, submit it.

Why this is the first channel built
-----------------------------------
Nobody holds an account on a Google Form; it is a public intake box. So
submitting one carries no ban risk, needs no browser, no stealth patching, no
session, and no credentials — it is an HTTP POST. That makes it the cheapest
possible path to a genuinely hands-off application, which is the whole point of
the resolver work.

Kept despite finding none yet
-----------------------------
The premise above was "a large share of Indian internship listings point at a
Google Form". Measured, that is wrong for the pool we actually accumulate: a
60-listing door probe found **0%**, and the production `jobs` table holds zero
form URLs. The honest reading is not that this sender is useless, though — it is
that DISCOVERY never reaches forms. They are posted on Instagram, in college
WhatsApp groups and on LinkedIn posts, none of which we crawl.

So this stays. It is a working, captcha-free, account-free Tier A sender that
costs nothing while idle, and deleting a sender because the crawler has not fed
it yet would be amputating the wrong end of the problem.

How a Google Form actually works
--------------------------------
The public `/viewform` page embeds its entire schema in a JS literal called
`FB_PUBLIC_LOAD_DATA_`. Each question carries a numeric `entry` id, its type,
its options and whether it is required. A response is an ordinary form POST to
the same URL with `/viewform` swapped for `/formResponse`, keyed `entry.<id>`.

Two things are hard blocks, and both fail closed here:
  * a file-upload question — Google requires a signed-in Google account to
    attach a file, so an unattended submit cannot satisfy it;
  * a form restricted to an organisation / requiring sign-in — the page
    redirects to accounts.google.com instead of serving a schema.

Both return `needs_review` rather than a partial submit. A half-answered
application sent under someone's name is worse than one not sent.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request

import questions
import safety

# Google's question type codes, from FB_PUBLIC_LOAD_DATA_.
_T_SHORT = 0
_T_PARAGRAPH = 1
_T_RADIO = 2
_T_DROPDOWN = 3
_T_CHECKBOX = 4
_T_SCALE = 5
_T_GRID = 7
_T_DATE = 9
_T_TIME = 10
_T_FILE = 13

# Types we can answer. Grids/dates/times are left alone: a wrong date on an
# application is a fact we invented, and `questions` exists precisely to stop
# that. If one of those is *required*, the form goes to review instead.
_ANSWERABLE = {_T_SHORT, _T_PARAGRAPH, _T_RADIO, _T_DROPDOWN, _T_CHECKBOX, _T_SCALE}

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

_LOAD_DATA_START_RE = re.compile(r"FB_PUBLIC_LOAD_DATA_\s*=\s*\[")


def _load_data_literal(html: str) -> str | None:
    """The FB_PUBLIC_LOAD_DATA_ array literal, extracted by bracket balancing.

    The obvious regex — capture up to ';</script>' — works only while that is the
    very next thing on the line. Google has shipped variants where another
    statement follows the assignment inside the same script block, and there the
    regex silently captures the wrong span, json.loads fails, and a perfectly
    answerable form reads as unparseable. Balancing brackets is immune to what
    comes after, and string/escape awareness keeps a ']' inside a question's text
    from ending the scan early.
    """
    m = _LOAD_DATA_START_RE.search(html or "")
    if not m:
        return None
    start = m.end() - 1                      # index of the opening '['
    depth = 0
    in_str = False
    escaped = False
    for i in range(start, len(html)):
        ch = html[i]
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return html[start: i + 1]
    return None

_FBZX_RE = re.compile(r'name="fbzx"\s+value="(-?\d+)"')
_CONFIRM_RE = re.compile(
    r"(your response has been recorded|response has been recorded|"
    r"thanks for submitting|freebirdFormviewerViewResponseConfirmationMessage)",
    re.I,
)
_SIGNIN_RE = re.compile(r"accounts\.google\.com/(v3/signin|ServiceLogin|signin)", re.I)


def _get(url: str, timeout: int = 25) -> tuple[str, str]:
    """GET a URL. Returns (html, final_url) — the final URL matters because a
    sign-in-gated form answers with a redirect rather than a schema."""
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace"), r.geturl()


def _post(url: str, fields: list[tuple[str, str]], timeout: int = 30) -> tuple[int, str]:
    body = urllib.parse.urlencode(fields, doseq=True).encode()
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "User-Agent": _UA,
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": url.replace("/formResponse", "/viewform"),
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.getcode(), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def response_url(view_url: str) -> str:
    """The POST endpoint for a given /viewform URL.

    Must be derived from the URL the form actually SERVED FROM, not the one we
    started with. A forms.gle short link is a redirect: deriving from it produced
    https://forms.gle/AbCd1234/formResponse, which does not exist — Google
    answered 404 and the channel filed the application as "listing closed", so
    the match was discarded and the user was never told. apply() passes the final
    URL from _get() for exactly this reason.

    The fragment is stripped along with the query: a link ending in
    "/viewform#responses" otherwise kept the fragment and POSTed back to the
    viewform, which renders the form again and submits nothing.
    """
    base = view_url.split("#", 1)[0].split("?", 1)[0]
    for suffix in ("/viewform", "/formResponse", "/edit", "/prefill"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.rstrip("/") + "/formResponse"


def parse_form(html: str) -> dict | None:
    """Extract a form schema from a /viewform page.

    Returns {"title", "pages", "fields": [...]} or None when the page carries no
    schema (sign-in wall, deleted form, or Google changed the payload shape —
    all of which must read as "cannot answer this", never as "no questions").
    """
    literal = _load_data_literal(html)
    if not literal:
        return None
    try:
        data = json.loads(literal)
    except (ValueError, TypeError):
        return None

    try:
        items = data[1][1] or []
    except (IndexError, TypeError):
        return None

    title = ""
    try:
        title = data[1][8] or data[3] or ""
    except (IndexError, TypeError):
        pass

    fields: list[dict] = []
    for item in items:
        try:
            label = (item[1] or "").strip()
            qtype = item[3]
            entries = item[4] or []
        except (IndexError, TypeError):
            continue

        for ent in entries:
            try:
                entry_id = ent[0]
                raw_options = ent[1] or []
                required = bool(ent[2])
            except (IndexError, TypeError):
                continue
            if entry_id is None:
                continue

            options = [
                str(o[0]).strip()
                for o in raw_options
                if isinstance(o, list) and o and str(o[0]).strip()
            ]
            fields.append({
                "entry_id": entry_id,
                "type": qtype,
                "label": label,
                "required": required,
                "options": options,
            })

    pages = 1
    for item in items:
        try:
            if item[3] == 8:  # page break
                pages += 1
        except (IndexError, TypeError):
            continue

    return {"title": str(title or "")[:200], "pages": pages, "fields": fields}


def _to_question_fields(schema_fields: list[dict]) -> list[dict]:
    """Map a Google Form schema onto the shape `questions.answer_fields` expects.

    Radio/checkbox become "select" on purpose: their answer must be one of the
    question's own option strings, and the option picker in `questions` already
    does exactly that. Sending a bare "Yes" to a radio whose option reads
    "Yes, I can join immediately" is a rejected submission.
    """
    out: list[dict] = []
    for f in schema_fields:
        t = f["type"]
        if t == _T_PARAGRAPH:
            kind = "textarea"
        elif t in (_T_RADIO, _T_DROPDOWN, _T_CHECKBOX, _T_SCALE):
            kind = "select"
        else:
            kind = "text"
        out.append({
            "el": f["entry_id"],
            "kind": kind,
            "label": f["label"],
            "required": f["required"],
            "options": f["options"],
        })
    return out


def blocking_reason(schema: dict) -> str | None:
    """Why this form cannot be submitted unattended, or None if it can."""
    for f in schema["fields"]:
        if f["type"] == _T_FILE:
            return "form requires a file upload (needs a signed-in Google account)"
    for f in schema["fields"]:
        if f["required"] and f["type"] not in _ANSWERABLE:
            return f"form requires an answer we will not invent: {f['label'][:60]!r}"
    if not any(f["type"] in _ANSWERABLE for f in schema["fields"]):
        return "no answerable questions found on the form"
    return None


def apply(
    job: dict,
    cover_letter: str,
    uid: str = "",
    profile: dict | None = None,
    resume_path: str | None = None,
    record: dict | None = None,
    *,
    target: str = "",
    skills: list[str] | None = None,
) -> tuple[str, str]:
    """Submit a Google Form application. Same (status, reason) contract as every
    platform adapter, so the worker treats it identically.

    status ∈ {applied, skipped, failed, needs_review}
    """
    profile = profile or {}
    record = record if record is not None else {}
    url = target or job.get("url") or ""
    if not url:
        return "skipped", "no form URL resolved"

    try:
        html, final_url = _get(url)
    except Exception as e:  # noqa: BLE001
        return "failed", f"could not load the form: {str(e)[:120]}"

    if _SIGNIN_RE.search(final_url) or _SIGNIN_RE.search(html[:4000]):
        return "needs_review", "form requires a Google sign-in — open it yourself"

    schema = parse_form(html)
    if not schema:
        return "needs_review", "could not read the form's questions — open it yourself"

    block = blocking_reason(schema)
    if block:
        return "needs_review", block

    qfields = _to_question_fields(schema["fields"])
    answers = questions.answer_fields(
        qfields,
        profile=profile,
        resume_text=profile.get("resume_text") or "",
        skills=skills or profile.get("skills") or [],
        job=job,
        name=profile.get("name") or "",
        email=profile.get("email") or "",
    )

    # A cover-letter-shaped box gets the letter we already wrote for this role
    # rather than a fresh generic paragraph.
    for rec, f in zip(answers, schema["fields"]):
        if cover_letter and f["type"] == _T_PARAGRAPH and re.search(
            r"(cover letter|why (should|do) (we|you)|tell us about yourself|"
            r"motivation|why this role)", f["label"], re.I,
        ):
            rec["answer"] = cover_letter[:900]
            rec["source"] = "cover_letter"

    payload: list[tuple[str, str]] = []
    unanswered_required: list[str] = []
    for rec, f in zip(answers, schema["fields"]):
        val = (rec.get("answer") or "").strip()
        if val == "__check__":
            # Only reachable if a checkbox slipped through as a non-select; the
            # literal sentinel is a Playwright instruction, never a form value.
            val = f["options"][0] if f["options"] else ""
        if not val:
            if f["required"]:
                unanswered_required.append(f["label"][:60])
            continue
        if f["options"] and val not in f["options"]:
            # Never send a value the question does not offer — Google rejects the
            # whole response, and a silently dropped answer is worse.
            match = next((o for o in f["options"] if o.lower() == val.lower()), None)
            if match is None:
                if f["required"]:
                    unanswered_required.append(f["label"][:60])
                continue
            val = match
        payload.append((f"entry.{f['entry_id']}", val))

    if unanswered_required:
        record["answers"] = questions.to_record(answers)
        return "needs_review", (
            "could not answer required question(s): "
            + "; ".join(unanswered_required[:3])
        )

    if not payload:
        return "needs_review", "nothing to submit — no answerable questions"

    fbzx = _FBZX_RE.search(html)
    payload.append(("fvv", "1"))
    payload.append(("pageHistory", ",".join(str(i) for i in range(schema["pages"]))))
    payload.append(("draftResponse", "[]"))
    if fbzx:
        payload.append(("fbzx", fbzx.group(1)))

    # final_url, not url: a forms.gle short link redirects, and the POST endpoint
    # only exists under the docs.google.com URL it landed on.
    #
    # Point of no return. The worker refunds the daily slot and idempotency
    # claim for a needs_review WITHOUT this flag; with it, both stay spent —
    # the POST may have landed even when the response is unreadable.
    record["submit_attempted"] = True
    code, body = _post(response_url(final_url or url), payload)
    record["answers"] = questions.to_record(answers)
    record["destination"] = url

    if code == 200 and _CONFIRM_RE.search(body):
        return "applied", "submitted to the company's Google Form — confirmation page received"
    if code == 200:
        # The POST went through but Google re-served the form, which is what it
        # does on a validation error. Never retry: a resubmit risks filing the
        # application twice, and `safety.classify_submit` takes the same line.
        return safety.APPLY_STATUS.NEEDS_REVIEW, (
            "form accepted the POST but showed no confirmation — verify manually"
        )
    if code in (401, 403):
        # A rejection at the door: Google refused the POST outright, so nothing
        # was recorded — this needs_review provably sent nothing.
        record["submit_attempted"] = False
        return "needs_review", "form is restricted (sign-in or organisation only)"
    if code == 404 or code == 410:
        return "skipped", "form no longer exists — listing is closed"
    return "failed", f"form rejected the submission (HTTP {code})"
