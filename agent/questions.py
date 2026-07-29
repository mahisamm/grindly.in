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

_CGPA = re.compile(r"\b(cgpa|gpa|grade point)\b", re.I)
# "percentage", "marks" and "score" were in the pattern above and had to come
# out. The stored `gpa` is the candidate's COLLEGE result; a form asking for
# "Class 12 percentage (%)" or "Your 10th marks" wants a different number
# entirely, and both were being answered "8.5" from the college CGPA — filed
# with source="profile", so it reads back to the user as verified fact.
#
# This catches the remaining half: a field that does say CGPA but asks for the
# school one ("Class 12 CGPA").
_SCHOOL_LEVEL = re.compile(
    r"\b(class\s*(x|xii|10|12)|10th|12th|tenth|twelfth|high\s*school|"
    r"secondary|intermediate|hsc|ssc|matric)\b",
    re.I,
)

# Questions that assert a CHECKABLE FACT about the candidate — a credential, a
# length of experience, a legal status, a commitment with consequences. These
# may never be auto-answered.
#
# `_CONFIRM` below used to swallow them whole. "Do you have 2+ years of
# experience with Django?", "Do you have a B.Tech degree in Computer Science?"
# and "Are you willing to relocate to Gurgaon?" all matched it and were answered
# "Yes" — recorded with source="profile" so the user saw them as verified. Three
# fabricated claims, typed into a real employer's form, under a real name, with
# nobody in the loop.
#
# Unanswered instead. A REQUIRED one then blocks the submit
# (channel_ats._unanswered_required, channel_google_form.blocking_reason) and the
# application waits for the candidate — the trade this module already makes
# everywhere else.
_FACTUAL_CLAIM = re.compile(
    # `are you (?:an?|currently)\b` needs that trailing boundary: without it the
    # bare `a` matched the first letter of "Are you AVAILABLE to start
    # immediately?", which is a genuine availability question and must still be
    # answerable.
    r"\b(do you have|have you|did you|are you (?:an?|currently)\b|"
    r"years?\s+of\s+experience|how\s+many\s+years|experience\s+(?:with|in)|"
    # NOTE the \w* on every truncated stem. Written as a bare prefix it would be
    # followed by the group's closing \b, which cannot match inside a word — so
    # "relocat" missed "relocate", "certif" missed "certification", "graduat"
    # missed "graduation" and "sponsor" missed "sponsorship". The relocation case
    # was live: "Are you willing to relocate to Gurgaon?" was still answered Yes.
    r"b\.?\s?tech|m\.?\s?tech|mba|bachelor|master|diploma|degree|graduat\w*|"
    r"certif\w*|licen[cs]e|clearance|sponsor\w*|visa|work\s+permit|"
    r"notice\s+period|relocat\w*)",
    re.I,
)
_PHONE = re.compile(r"\b(phone|mobile|contact number|whatsapp)\b", re.I)
_EMAIL = re.compile(r"\b(e-?mail)\b", re.I)

# The rest of what a screening form asks and a resume does not carry. Every one
# of these was already REFUSED by _FACTUAL_CLAIM / _WANTS_A_DATUM below — which
# was right while the answers existed nowhere, and became the reason applications
# stalled once setup started collecting them. The facts were being stored and
# never read. Answering from the profile is not a relaxation of the no-invention
# rule: it is the rule working as designed, with the user as the source.
_GRAD_YEAR_Q = re.compile(
    r"\b(graduation\s+year|year\s+of\s+(graduation|passing)|passing\s*(-|\s)?out\s+year|"
    r"passing\s+year|batch\s+year|when\s+do\s+you\s+graduate|expected\s+graduation)\b",
    re.I,
)
_HOURS_Q = re.compile(
    r"\bhours?\s+(per|a|each)\s+(week|day)\b|\bweekly\s+hours\b|"
    r"\bhours?\s+.{0,20}\b(commit|devote|dedicate|spare)\b",
    re.I,
)
_START_Q = re.compile(
    r"\b(when\s+can\s+you\s+(start|join)|start(ing)?\s+date|joining\s+date|"
    r"available\s+(from|to\s+start)|earliest\s+(start|joining)|notice\s+period)\b",
    re.I,
)
_RELOCATE_Q = re.compile(r"\brelocat\w*\b", re.I)
# Asks for a date or a period, never for a yes/no.
_WHEN_Q = re.compile(
    r"^\s*(when|what\s+(date|day)|which\s+date|how\s+soon)\b|"
    r"\b(notice\s+period|start(ing)?\s+date|joining\s+date|available\s+from)\b",
    re.I,
)
_WORK_AUTH_Q = re.compile(
    r"\b(work\s+authori[sz]ation|authori[sz]ed\s+to\s+work|"
    r"(require|need)\w*\s+(visa|sponsorship)|sponsorship|work\s+permit|citizenship)\b",
    re.I,
)
# "Nationality" used to be matched here and answered with the work-authorization
# sentence — so a box asking for one word got "Indian citizen — need sponsorship
# to work abroad". It has its own stored fact and its own pattern now.
_STIPEND_Q = re.compile(
    r"\bexpected\s+(stipend|salary|ctc|compensation|pay)\b|"
    r"\b(stipend|salary)\s+expectation\b",
    re.I,
)
# Questions a measured dry run of fourteen real application pages actually
# stalled on. Every one is a fact about the candidate that no model may supply,
# so each maps to a value the user stated once in setup.
_CURRENT_SALARY_Q = re.compile(
    r"\b(current|present|existing)\s+(salary|ctc|compensation|pay|package)\b|"
    r"\bcurrent\s+annual\s+(salary|income)\b|\bsalary\s+drawn\b",
    re.I,
)
_PREV_INTERNSHIP_Q = re.compile(
    r"\b(previous|prior|past|any)\s+internship\b|"
    r"\binternship\s+experience\b|"
    r"\bhave\s+you\s+(ever\s+)?(done|completed|had|interned)\b[^?]{0,40}\bintern",
    re.I,
)
_NOTICE_Q = re.compile(
    r"\bnotice\s+period\b|\bhow\s+soon\s+can\s+you\s+join\b|\bjoining\s+time\b",
    re.I,
)
_CURRENT_LOCATION_Q = re.compile(
    r"\b(current|present)\s+(location|city|residence|address)\b|"
    r"\bwhere\s+are\s+you\s+(currently\s+)?(based|located|living)\b|"
    r"\bcity\s+of\s+residence\b",
    re.I,
)
_GENDER_Q = re.compile(r"\bgender\b", re.I)
_DOB_Q = re.compile(r"\b(date\s+of\s+birth|d\.?o\.?b\.?|birth\s*date)\b", re.I)
_DISABILITY_Q = re.compile(
    r"\b(differently[\s-]?abled|disabilit(y|ies)|physically\s+challenged|"
    r"person\s+with\s+a\s+disability)\b",
    re.I,
)
_NATIONALITY_Q = re.compile(r"\bnationalit(y|ies)\b|\bcountry\s+of\s+citizenship\b", re.I)
_COLLEGE_Q = re.compile(r"\b(college|university|institute|institution)\b", re.I)
_DEGREE_Q = re.compile(
    r"\b(degree|course|qualification|programme|program|branch|stream|"
    r"speciali[sz]ation|major|discipline)\b",
    re.I,
)
_SPONSORSHIP_Q = re.compile(
    r"\b(require|need|request)\w*\s+(visa\s+)?sponsorship\b|"
    r"\bsponsorship\s+(required|needed)\b|\bwill\s+you\s+require\s+sponsorship\b",
    re.I,
)
_PERCENT_Q = re.compile(r"\b(percentage|percent|marks|score|aggregate|result)\b|%", re.I)
_CLASS10_Q = re.compile(r"\b(class\s*(x|10)|10th|tenth|ssc|matric\w*)\b", re.I)
_CLASS12_Q = re.compile(r"\b(class\s*(xii|12)|12th|twelfth|hsc|intermediate|senior\s+secondary)\b", re.I)
_LINKEDIN_Q = re.compile(r"\blinked-?in\b", re.I)
_GITHUB_Q = re.compile(r"\bgit\s?hub\b", re.I)
_PORTFOLIO_Q = re.compile(r"\b(portfolio|personal\s+(web)?site|website|blog)\b", re.I)
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

# Whose name is being asked for. A Google Form very often labels the field just
# "Name" — which the old `\b(your name|full name|first name)\b` did not match, so
# the candidate's name field received a two-sentence LLM paragraph. On a real
# application, under their real identity.
#
# The negative list is the important half: "Company name", "College name" and
# "Father's name" are all common on Indian internship forms and none of them are
# the candidate. Answering those from the candidate's name is not a formatting
# slip, it is a false statement, so they stay unanswered.
_NAME_OWNER_OTHER = re.compile(
    r"\b(company|organi[sz]ation|employer|college|school|institute|university|"
    r"course|degree|project|team|referr?er|reference|father|mother|parent|"
    r"guardian|spouse|emergency|bank|account|city|state|country|file|document)\b",
    re.I,
)
_NAME_SELF = re.compile(
    r"^\s*(full\s+|your\s+|candidate\s+|applicant\s+|student\s+|legal\s+)?name\b"
    r"|\b(your|full|candidate|applicant|student)\s+name\b",
    re.I,
)
_FIRST_NAME = re.compile(r"\b(first|given)\s+name\b", re.I)
_LAST_NAME = re.compile(r"\b(last|sur|family)\s*name\b", re.I)

# Options that mean "yes" on a choice question. A choice question is only
# auto-answered when one of its own options matches this — see _pick_option.
# Questions that want a specific datum — a number, a figure, a date — not prose.
# The generic fallback paragraph further down is written for "why do you want
# this role"; dropped into "Expected stipend", "Hours per week" or "Class 12
# percentage (%)" it is useless to the recruiter and usually rejected outright
# by a numeric input.
_WANTS_A_DATUM = re.compile(
    r"\b(percentage|marks|score|cgpa|gpa|stipend|salary|ctc|expected\s+pay|"
    r"hours?\s+per|how\s+many|how\s+much|passing\s+year|year\s+of|"
    r"date\s+of|duration|number\s+of|age)\b",
    re.I,
)

_AFFIRMATIVE_OPTION = re.compile(
    r"^\s*(yes|yeah|yep|sure|available|immediately|i (can|am|do|will|agree)|"
    r"agree|accept|confirm|true|ok(ay)?)\b",
    re.I,
)
_PLACEHOLDER_OPTION = re.compile(r"^\s*(select|choose|--|please|pick|none|n/?a)\b", re.I)


def _name_answer(label: str, name: str) -> str | None:
    """The candidate's name, split correctly if the form asks for one half.

    Separate First/Last fields used to BOTH receive the full name, so a form with
    "First name" and "Last name" went out reading "Asha Rao Asha Rao".
    """
    if not name or _NAME_OWNER_OTHER.search(label):
        return None
    parts = name.split()
    if _FIRST_NAME.search(label):
        return parts[0] if parts else None
    if _LAST_NAME.search(label):
        return " ".join(parts[1:]) if len(parts) > 1 else None
    if _NAME_SELF.search(label):
        return name
    return None


def _pick_option(field: dict) -> str | None:
    """The answer for a choice question, or None when there is no honest one.

    The old rule was "an affirmative option, else the first non-placeholder one".
    That second half invents facts: for "Preferred campus — Pune / Chennai" it
    silently picked Pune, and for a 1-to-5 rating scale it picked 1 — the lowest
    possible self-assessment, submitted unattended, under the candidate's name.

    So a choice question is answered only when one of its own options is an
    affirmative. Anything else is a preference or a claim we do not hold, and it
    is left unanswered — which makes a REQUIRED one block the submission
    (channel_google_form.apply returns needs_review) instead of guessing.
    """
    # Read the QUESTION before the options. Picking the affirmative from the
    # options alone answered "Do you require visa sponsorship?" [Yes/No] with
    # "Yes", and "What is your notice period?" [Immediately/15 days/1 month]
    # with "Immediately" — because those option words are themselves
    # affirmatives. Both are checkable claims about the candidate, and
    # channel_google_form maps every radio and dropdown here, so both were being
    # POSTed unattended to real employers.
    if _FACTUAL_CLAIM.search(field.get("label") or ""):
        return None
    options = field.get("options") or []
    for o in options:
        if _AFFIRMATIVE_OPTION.match(o):
            return o
    return None


def _fit_option(field: dict, value: str) -> str | None:
    """Map a stored answer onto one of the field's OWN options.

    A dropdown can only be given a label it actually offers — "Yes" typed into a
    select whose option reads "Yes, I can relocate" makes select_option() throw
    and takes the whole application down. When nothing matches, the caller falls
    through and the field is left for the user, which is the honest outcome for a
    question we can't express in the form's own vocabulary.
    """
    options = field.get("options") or []
    if not options:
        return value
    low = value.strip().lower()
    for option in options:
        if str(option).strip().lower() == low:
            return option
    for option in options:
        text = str(option).strip().lower()
        if text.startswith(low) or low.startswith(text):
            return option
    return None


def _from_setup(label: str, field: dict, profile: dict) -> str | None:
    """Answers the user gave in setup, matched to the question being asked.

    Nothing here is derived, inferred, or phrased by a model — each one is a
    value the user typed or picked, returned verbatim. A fact we do not hold
    returns None and the application stops for them, exactly as before.
    """
    def _text(key: str) -> str:
        return str(profile.get(key) or "").strip()

    def _num(key: str) -> str:
        value = profile.get(key)
        if value in (None, "", 0):
            return ""
        # 94.0 is a percentage a human wrote as 94. A form's numeric input often
        # rejects the decimal, and a recruiter reading "94.0%" sees a machine.
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)

    # Order matters throughout: "Which college/university?" also matches
    # _DEGREE_Q on "course", and the college is the more specific answer. The
    # school-level percentages come before the grade/percentage catch-alls for
    # the same reason.
    candidates: list[tuple[bool, str]] = [
        (bool(_SPONSORSHIP_Q.search(label)), _text("needs_sponsorship")),
        # Ahead of the stipend and start-date patterns below, which both claim
        # some of the same words: "current salary" is not "expected salary", and
        # "notice period" is its own box on forms that also ask when you start.
        (bool(_CURRENT_SALARY_Q.search(label)), _text("current_salary")),
        (bool(_PREV_INTERNSHIP_Q.search(label)), _text("previous_internship")),
        (bool(_NOTICE_Q.search(label)), _text("notice_period")),
        (bool(_CURRENT_LOCATION_Q.search(label)), _text("current_location")),
        (bool(_GENDER_Q.search(label)), _text("gender")),
        (bool(_DOB_Q.search(label)), _text("date_of_birth")),
        (bool(_DISABILITY_Q.search(label)), _text("differently_abled")),
        (bool(_NATIONALITY_Q.search(label)), _text("nationality")),
        # A percentage only answers a question that ASKS for one. "Class 12 board
        # name" and "Intermediate college" match the school-level pattern too,
        # and a percentage typed into either is nonsense.
        (bool(_CLASS10_Q.search(label) and _PERCENT_Q.search(label)), _num("class10_percent")),
        (bool(_CLASS12_Q.search(label) and _PERCENT_Q.search(label)), _num("class12_percent")),
        (bool(_LINKEDIN_Q.search(label)), _text("linkedin_url")),
        (bool(_GITHUB_Q.search(label)), _text("github_url")),
        (bool(_PORTFOLIO_Q.search(label)), _text("portfolio_url")),
        (bool(_GRAD_YEAR_Q.search(label)), _num("grad_year")),
        (bool(_HOURS_Q.search(label)), _num("hours_per_week")),
        (bool(_STIPEND_Q.search(label)), _num("expected_stipend")),
        (bool(_START_Q.search(label)), _text("availability")),
        (bool(_RELOCATE_Q.search(label)), _text("willing_to_relocate")),
        (bool(_WORK_AUTH_Q.search(label)), _text("work_authorization")),
        # Never on a school-level question. "Intermediate college name" and
        # "Class 12 stream" match these patterns and are asking about the
        # candidate's SCHOOL — answering them with the university and the B.Tech
        # states two facts that aren't true, on a form, under their name.
        # No `education` fallback here. That column is the combined "course and
        # college" line, and on older accounts it often holds only the course —
        # seen live, a "College name" box was answered "B.Tech". Better to stop
        # and ask than to write the degree where the college goes.
        (bool(_COLLEGE_Q.search(label) and not _SCHOOL_LEVEL.search(label)),
         _text("college")),
        (bool(_DEGREE_Q.search(label) and not _SCHOOL_LEVEL.search(label)),
         _text("degree") or _text("education")),
    ]
    for matches, value in candidates:
        if matches and value:
            return _fit_option(field, value)
    return None


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
    if _CGPA.search(label) and not _SCHOOL_LEVEL.search(label):
        gpa = profile.get("gpa")
        return str(gpa) if gpa else None
    named = _name_answer(label, name)
    if named:
        return named

    stored = _from_setup(label, field, profile)
    if stored is not None:
        return stored
    if kind in ("checkbox", "radio") and field["required"]:
        return "__check__"
    # NOT a select: a dropdown's answer has to be one of ITS OWN option labels, and
    # a bare "Yes" won't match an option that reads "Yes, immediately" —
    # select_option() would throw. Selects fall through to the option picker.
    if (
        _CONFIRM.search(label)
        and not _FACTUAL_CLAIM.search(label)
        # A question asking WHEN is not a yes/no question. "When can you start?"
        # matches _CONFIRM on "can you start" and was being answered "Yes" in a
        # free-text box — the same shape of nonsense that got "duration" removed
        # from this branch. "Are you available to start immediately?" still is a
        # yes/no and still gets one.
        and not _WHEN_Q.search(label)
        and kind not in ("textarea", "select")
    ):
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
            # Only an affirmative option. See _pick_option for why "first real
            # choice" was removed: it turned every preference question into an
            # invented fact, and every rating scale into a 1-out-of-5.
            pick = _pick_option(f)
            out.append({
                "question": f["label"], "answer": pick or "",
                "source": "default" if pick else "unanswerable", "kind": "select", "_i": i,
            })
            continue

        # A question wanting a specific figure never goes to the LLM. Anything
        # it can honestly say there is prose, and prose is the wrong shape: live
        # in production the model answered "Class 12 percentage (%)" with
        # "Information not available" and "Do you have a B.Tech degree?" with
        # "My resume does not mention...". Neither is a lie, but a numeric input
        # rejects them outright and a recruiter reading a percentage box wants a
        # number — and, worse, a non-empty answer defeats the required-field
        # block in channel_ats/channel_google_form, so the application goes out
        # with the question effectively unanswered instead of waiting for the
        # candidate. Anything genuinely known (CGPA, phone, email) was already
        # answered from the profile above and never reaches here.
        # A checkable claim about the candidate is theirs to make, so it never
        # reaches the model either. The model only ever sees the parsed resume,
        # so when extraction misses something it answers "My resume does not
        # mention a B.Tech degree" — volunteering a DENIAL of a credential the
        # candidate may well hold, under their name, to an employer, permanently.
        # That is the same failure as the old auto-"Yes" pointed the other way.
        #
        # The cost is real and accepted: more applications stop for the
        # candidate to finish. An application that waits is recoverable; a
        # misstatement sent to an employer is not.
        if _WANTS_A_DATUM.search(f["label"] or "") or _FACTUAL_CLAIM.search(f["label"] or ""):
            out.append({
                "question": f["label"], "answer": "",
                "source": "unanswerable", "kind": f["kind"], "_i": i,
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
        # Never let the generic paragraph stand in for a checkable fact. Put it
        # in a "Do you have a B.Tech degree?" or "Years of experience" box and it
        # is both nonsense to the recruiter and an implied claim; leaving it
        # blank blocks the submit instead, and the candidate answers it.
        label_l = f["label"] or ""
        if _FACTUAL_CLAIM.search(label_l) or _WANTS_A_DATUM.search(label_l):
            continue
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
