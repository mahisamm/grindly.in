"""Answer a form the agent cannot open, from a snapshot the browser sends us.

Why this exists
---------------
The wall in front of unattended applying is not technical. Keka types a captcha
at you, some Greenhouse tenants email an 8-character code, Internshala wants a
session. Every one of those checks is asking the same question — *is a human
here?* — and from a datacenter the honest answer is no.

In the student's own browser the answer is yes. So the browser becomes the
hands. But the extension's own decision logic is four regexes (phone, email,
CGPA, name); it cannot read a `<select>` at all, and it knows nothing about
gender, school, degree, years of experience, notice period, expected stipend, or
any of the forty-odd facts `questions.py` learned to answer — most of them the
hard way, against real forms that stopped mid-application.

Rewriting that in JavaScript would mean rediscovering every one of those bugs a
second time, in a language with no test suite covering them.

So the split is: **the browser is the hands, this is the brain.** The extension
serialises what it can see and posts it here; this module runs the SAME engine
the server-side sender uses — same patterns, same option fitting, same refusals
— and hands back a list of values to type. Nothing here touches a browser, and
nothing here decides to submit.

The contract
------------
In:  [{index, label, kind, required, options[], value}]  + who the candidate is
Out: [{index, value, kind, source}]                      + what it refused, and why

`source` travels with every answer on purpose, exactly as it does on the server
path: "profile" means we stated a fact the user gave us, "ai" means a model
phrased something from their resume, "unanswerable" means we would have had to
invent it and did not. The extension shows that to the user; a silent guess is
the one outcome this whole system is built to prevent.
"""
from __future__ import annotations

import json
import re

import questions

# Which box is the cover-letter box.
#
# `questions.py` deliberately refuses to answer these — see _SKIP_NAMES — because
# the letter is composed per application, upstream, and dropping boilerplate into
# a screening question is worse than leaving it blank. So every caller supplies
# it, and this is the caller for the browser path. Kept in step with
# channel_ats._COVER_RE, which does the same job for the server path.
_COVER_RE = re.compile(
    r"(cover letter|covering letter|why (should|do) (we|you)|"
    r"why (this|our) (role|company|job)|tell us about yourself|motivation|"
    r"additional information|anything else|introduce yourself)",
    re.I,
)

# Kinds the answering engine understands. Anything else the browser saw is
# passed through untouched rather than guessed at — a widget we cannot name is
# a widget we cannot answer honestly.
_KNOWN_KINDS = {
    "text", "textarea", "email", "tel", "number", "url", "date",
    "select", "combobox", "checkbox", "radio",
}


def _clean_field(raw: dict, index: int) -> dict | None:
    """One serialized control, in the shape `questions.answer_fields` expects.

    Returns None for anything unanswerable by construction — no label to match
    against, or a kind we do not model. Dropping it here keeps the engine's own
    assumptions intact rather than feeding it a half-field.
    """
    label = str(raw.get("label") or "").strip()
    kind = str(raw.get("kind") or raw.get("type") or "text").strip().lower()
    if kind not in _KNOWN_KINDS:
        kind = "text"
    if not label:
        return None

    options = raw.get("options") or []
    if not isinstance(options, list):
        options = []
    options = [str(o).strip() for o in options if str(o).strip()][:400]

    # The browser's own address for this control. Fall back to position rather
    # than trusting it blindly: a plan that comes back with a bad index types
    # the right answer into the wrong box, which is worse than not typing it.
    try:
        own_index = int(raw.get("index", index))
    except (TypeError, ValueError):
        own_index = index

    return {
        # No live element: this whole module exists to answer without one.
        "el": None,
        "label": label[:300],
        "kind": kind,
        "required": bool(raw.get("required")),
        "options": options,
        # The engine skips a field the page has already answered, and the
        # browser is the only thing that can know that.
        "value": str(raw.get("value") or ""),
        "_index": own_index,
    }


def plan(
    raw_fields: list[dict],
    *,
    profile: dict,
    resume_text: str = "",
    skills: list | str | None = None,
    job: dict | None = None,
    name: str = "",
    email: str = "",
    cover_letter: str = "",
) -> dict:
    """What to type into this form, decided by the server-side engine.

    Never raises: a browser waiting on a fill plan must get an answer, and an
    empty plan (fill nothing, tell the user why) is a correct answer.
    """
    if isinstance(skills, str):
        try:
            skills = json.loads(skills or "[]")
        except Exception:  # noqa: BLE001
            skills = []
    skills = [str(s) for s in (skills or [])]
    job = job or {}

    fields: list[dict] = []
    keep: list[int] = []          # engine position -> the browser's own index
    for i, raw in enumerate(raw_fields or []):
        f = _clean_field(raw or {}, i)
        if f is None:
            continue
        # Already answered by the page or the user. Typing over it is how a
        # prefilled name became "SammetaMahendhar" on a live Keka form.
        if f["value"].strip() and f["kind"] not in ("select", "combobox"):
            continue
        keep.append(f.pop("_index"))
        fields.append(f)

    if not fields:
        return {"fills": [], "unanswered": [], "considered": 0}

    try:
        answers = questions.answer_fields(
            fields,
            profile=profile or {},
            resume_text=resume_text or "",
            skills=skills,
            job=job,
            name=name,
            email=email,
        )
    except Exception as e:  # noqa: BLE001
        # The browser gets a refusal it can show, not a stack trace and a
        # half-filled form.
        return {"fills": [], "unanswered": [], "considered": len(fields),
                "error": f"{type(e).__name__}: {e}"[:200]}

    fills: list[dict] = []
    unanswered: list[dict] = []
    for rec in answers:
        pos = rec.get("_i")
        if pos is None or pos >= len(keep):
            continue
        field = fields[pos]
        value = str(rec.get("answer") or "")
        entry = {
            "index": keep[pos],
            "label": field["label"],
            "kind": field["kind"],
            "required": field["required"],
            "source": rec.get("source") or "",
        }
        if value.strip():
            fills.append({**entry, "value": value})
        else:
            unanswered.append(entry)

    # The cover letter is the one answer the engine deliberately does not write:
    # it is composed per application, upstream, and only ever belongs in a box
    # that asked for prose. Placed here so a form with such a box is completable
    # while the engine keeps refusing to put boilerplate in a screening question.
    #
    # It also OVERRIDES whatever else landed in such a box — the engine's
    # generic fallback, or a model's paragraph. Both exist so a free-text
    # question is not left empty, but a letter written for THIS employer beats
    # either, and channel_ats already prefers the letter here; without this the
    # two paths answer the same box differently depending only on whether an
    # LLM happened to be reachable.
    if cover_letter:
        for entry in unanswered + list(fills):
            if entry["kind"] != "textarea":
                continue
            if entry.get("source") == "cover":
                continue
            if not _COVER_RE.search(entry["label"]):
                continue
            fills = [f for f in fills if f["index"] != entry["index"]]
            fills.append({**{k: v for k, v in entry.items() if k != "value"},
                          "value": cover_letter, "source": "cover"})
        placed = {f["index"] for f in fills}
        unanswered = [u for u in unanswered if u["index"] not in placed]

    return {
        "fills": fills,
        # Required and unanswered is what stops a submit. The extension shows
        # these to the user rather than sending the form half-empty.
        "unanswered": [u for u in unanswered if u["required"]],
        "considered": len(fields),
    }
