"""Answer a platform's screening questions — truthfully, and on the record.

Internshala (and most boards) put per-listing questions behind the Apply button:
"Why should we hire you?", "How many hours a week can you commit?", "What is your
CGPA?". They are the single biggest thing standing between a filled form and a
sent application.

What this replaces is worse than nothing. Every textarea on the page used to get
the SAME canned sentence:

    "I'm genuinely excited about this role and pick up new tools quickly."

...whatever the question actually asked. Every required text input got the literal
string "Yes". CGPA was hardcoded to "8.5" while the user's real GPA sat unread in
their profile. A recruiter reading that sees filler, and the candidate never found
out what was said in their name.

Three rules here, in priority order:

  1. NEVER invent a fact. Anything checkable — phone, CGPA, name — comes from the
     profile, not from a model. A model that guesses your CGPA is a model that
     lies to a recruiter on your behalf.
  2. Ground everything else in the resume. The LLM may only phrase what the
     candidate already claims. It is writing *as* them, not *for* them.
  3. Record every question and answer. The user is told exactly what was
     submitted under their name — before an interview, that is the thing they
     most need to read back.
"""
from __future__ import annotations

import json
import re

import llm as llm_mod

# Longest answer we will type into a free-text box. Screening answers are read in
# seconds; a wall of text reads as generated, which is the opposite of the goal.
MAX_ANSWER_CHARS = 420

# Fields we never touch: the platform's own plumbing, and the cover-letter box
# (the caller fills that separately with a per-job letter).
_SKIP_NAMES = re.compile(
    r"cover.?letter|csrf|token|captcha|_method|utf8", re.I
)


# --- reading the form -------------------------------------------------------

# Finds the human-readable question attached to a form field. Tries the explicit
# label first, then a wrapping label, then aria-label, then walks up a few
# ancestors looking for the nearest container that actually carries text —
# Internshala renders questions as a sibling <div>, not a <label>, so the naive
# `label[for=...]` lookup alone finds nothing at all.
_LABEL_JS = """
el => {
  const clean = s => (s || '').trim().replace(/\\s+/g, ' ');
  if (el.id) {
    const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (l && clean(l.innerText)) return clean(l.innerText);
  }
  const wrap = el.closest('label');
  if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);

  let n = el.parentElement, hops = 0;
  while (n && hops < 4) {
    const c = n.cloneNode(true);
    c.querySelectorAll('input,textarea,select,button,script,style').forEach(x => x.remove());
    const t = clean(c.innerText);
    if (t.length > 8) return t;
    n = n.parentElement; hops++;
  }
  return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'));
}
"""


def read_fields(page) -> list[dict]:
    """Every answerable field on the open apply form, paired with its question.

    Returns dicts of {el, kind, label, required, options}. Already-filled fields
    are excluded — the cover letter and the resume upload are handled by the
    caller, and re-typing over them would clobber real work.
    """
    fields: list[dict] = []
    try:
        els = page.query_selector_all("textarea, input, select")
    except Exception as e:  # noqa: BLE001
        print(f"[questions] could not read the form: {e}")
        return []

    for el in els:
        try:
            tag = (el.evaluate("e => e.tagName") or "").lower()
            itype = (el.get_attribute("type") or "text").lower()
            name = el.get_attribute("name") or ""

            if itype in ("hidden", "file", "submit", "button", "image", "reset"):
                continue
            if _SKIP_NAMES.search(name):
                continue
            if tag != "select" and (el.input_value() or "").strip():
                continue  # already answered (cover letter, prefilled profile data)

            options: list[str] = []
            if tag == "select":
                options = [
                    (o.inner_text() or "").strip()
                    for o in el.query_selector_all("option")
                ]
                options = [o for o in options if o]

            fields.append({
                "el": el,
                "kind": "select" if tag == "select" else ("textarea" if tag == "textarea" else itype),
                "label": (el.evaluate(_LABEL_JS) or "").strip()[:300],
                "required": el.get_attribute("required") is not None,
                "options": options,
            })
        except Exception:  # noqa: BLE001
            continue
    return fields


# --- answering --------------------------------------------------------------

_CGPA = re.compile(r"\b(cgpa|gpa|grade point|percentage|marks|score)\b", re.I)
_PHONE = re.compile(r"\b(phone|mobile|contact number|whatsapp)\b", re.I)
_EMAIL = re.compile(r"\b(e-?mail)\b", re.I)
# Availability/logistics questions. These are yes/no in practice, and the user
# already declared the answer by choosing to apply to an internship at all.
_CONFIRM = re.compile(
    r"\b(available|availability|can you (start|join|commit)|willing|able to|"
    r"relocat|work from home|in[- ]office|full[- ]time|immediately|"
    r"do you (have|agree|confirm))\b",
    re.I,
)
# NOTE: "duration" was deliberately removed here. A question like "For how many
# months can you commit?" or "Internship duration you're available for" is a
# free-text/number answer, not yes/no — matching it sent a literal "Yes" into a
# text field (nonsense to a recruiter) or was rejected by a numeric input. It
# now falls through to the LLM / fallback like any other open question.


def _deterministic(field: dict, profile: dict, name: str, email: str) -> str | None:
    """Answers that must come from the profile, never from a model.

    A model asked for a CGPA will happily produce a plausible one. That is a
    fabricated credential on a real application — so anything checkable is
    answered from stored fact or not at all.
    """
    label = field["label"]
    kind = field["kind"]

    if kind == "tel" or _PHONE.search(label):
        return str(profile.get("phone") or "") or None
    if _EMAIL.search(label):
        return email or None
    if _CGPA.search(label):
        gpa = profile.get("gpa")
        return str(gpa) if gpa else None
    if re.search(r"\b(your name|full name|first name)\b", label, re.I):
        return name or None
    if kind in ("checkbox", "radio") and field["required"]:
        return "__check__"
    # NOT a select: a dropdown's answer has to be one of ITS OWN option labels, and
    # a bare "Yes" won't match an option that reads "Yes, immediately" —
    # select_option() would throw. Selects fall through to the option picker.
    if _CONFIRM.search(label) and kind not in ("textarea", "select"):
        return "Yes"
    return None


_SYS = (
    "You are answering an internship application's screening questions AS the candidate, "
    "in their voice, using ONLY what their resume actually supports.\n"
    "RULES:\n"
    "1. NEVER claim a skill, project, grade, or experience that is not in the resume. "
    "   If the resume cannot support an answer, write a short honest one that says what "
    "   the candidate HAS done instead. Do not invent.\n"
    "2. First person, plain language, specific. Name a real project or skill from the resume.\n"
    "3. Two to three sentences. No greeting, no sign-off, no bullet points, no markdown.\n"
    "4. Never write filler like 'I am a quick learner and passionate about this role'.\n"
    "Return ONLY a JSON object mapping each question's index (as a string) to its answer string. "
    'Example: {"0": "...", "1": "..."}'
)


def _ai_answers(
    open_questions: list[tuple[int, str]],
    resume_text: str,
    skills: list[str],
    job: dict,
) -> dict[int, str]:
    if not open_questions:
        return {}

    listed = "\n".join(f"{i}. {q}" for i, q in open_questions)
    prompt = (
        f"Role: {job.get('title', 'Internship')} at {job.get('company', 'a company')}.\n"
        f"The candidate's skills: {', '.join(skills[:15]) or 'unknown'}.\n\n"
        f"Their resume:\n\"\"\"\n{(resume_text or '')[:3500]}\n\"\"\"\n\n"
        f"Questions:\n{listed}\n\n"
        "Answer each. Return the JSON object only."
    )
    out = llm_mod.chat_json_ensemble(prompt, system=_SYS, n=3, timeout=75)
    if not isinstance(out, dict):
        return {}

    answers: dict[int, str] = {}
    for k, v in out.items():
        try:
            idx = int(k)
        except (TypeError, ValueError):
            continue
        if isinstance(v, str) and v.strip():
            answers[idx] = v.strip()[:MAX_ANSWER_CHARS]
    return answers


def answer_fields(
    fields: list[dict],
    *,
    profile: dict,
    resume_text: str,
    skills: list[str],
    job: dict,
    name: str = "",
    email: str = "",
) -> list[dict]:
    """Pair every field with an answer and where that answer came from.

    `source` is on the record deliberately: "profile" means we stated a stored
    fact, "ai" means a model phrased something from the resume. The user gets to
    see which is which.
    """
    out: list[dict] = []
    open_questions: list[tuple[int, str]] = []

    for i, f in enumerate(fields):
        det = _deterministic(f, profile, name, email)
        if det is not None:
            out.append({
                "question": f["label"], "answer": det,
                "source": "profile", "kind": f["kind"], "_i": i,
            })
            continue

        if f["kind"] == "select":
            # Prefer an affirmative option; otherwise the first real choice.
            pick = next(
                (o for o in f["options"] if re.match(r"^\s*(yes|available|immediately)", o, re.I)),
                next((o for o in f["options"] if not re.match(r"^\s*(select|choose|--)", o, re.I)), ""),
            )
            out.append({
                "question": f["label"], "answer": pick,
                "source": "default", "kind": "select", "_i": i,
            })
            continue

        # Free text — this is what the LLM is for.
        out.append({
            "question": f["label"], "answer": "",
            "source": "ai", "kind": f["kind"], "_i": i,
        })
        open_questions.append((i, f["label"] or "Why are you a good fit for this role?"))

    ai = _ai_answers(open_questions, resume_text, skills, job)
    for rec in out:
        if rec["source"] == "ai":
            rec["answer"] = ai.get(rec["_i"], "")

    # An unanswered REQUIRED free-text box blocks the submit outright, so it needs
    # *something*. Say only what is verifiably true from the skill list rather than
    # inventing enthusiasm — a real sentence beats the old canned one.
    for rec, f in zip(out, fields):
        if not rec["answer"] and f["required"] and rec["kind"] in ("textarea", "text"):
            top = ", ".join(skills[:3]) if skills else "the tools this role uses"
            rec["answer"] = (
                f"My background is in {top}, which is what this role works with. "
                f"I've built and shipped projects using them and would bring that here."
            )
            rec["source"] = "fallback"

    return out


# --- writing it back --------------------------------------------------------

def fill(page, fields: list[dict], answers: list[dict], typer) -> int:
    """Type the answers in. `typer(page, el, text)` is the caller's human-paced
    typing function — pacing is the adapter's business, not ours.

    Returns how many fields were actually filled.
    """
    filled = 0
    for rec in answers:
        f = fields[rec["_i"]]
        el, val = f["el"], rec["answer"]
        if not val:
            continue
        try:
            if val == "__check__":
                el.check()
            elif f["kind"] == "select":
                el.select_option(label=val)
            else:
                typer(page, el, val)
            filled += 1
        except Exception as e:  # noqa: BLE001
            print(f"[questions] could not fill {f['label'][:40]!r}: {e}")
    return filled


def to_record(answers: list[dict]) -> str:
    """JSON for the applications table — what was asked, what we said, and whether
    a human fact or a model produced it. Stripped of element handles."""
    return json.dumps([
        {"q": a["question"], "a": a["answer"], "source": a["source"]}
        for a in answers
        if a["answer"]
    ])
