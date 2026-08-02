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
import os
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
  // A React combobox has no <label for>, but it does point at its question with
  // aria-labelledby. Without this the ancestor walk below reads the widget's own
  // placeholder — which is how "Select..." and "Search" ended up being treated
  // as the questions on a real Greenhouse application, and answered.
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const text = by.split(/\\s+/)
      .map(id => document.getElementById(id))
      .filter(Boolean)
      .map(n => clean(n.innerText))
      .filter(Boolean)
      .join(' ');
    if (text) return text;
  }
  const wrap = el.closest('label');
  if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);

  // The field's OWN <label>, when the form did not wire up `for`.
  //
  // Keka does not: its gender control is <select id="gender"> with a plain
  // sibling <label>Gender *</label> and no `for` attribute. Falling straight
  // through to the ancestor-text walk below returned the first ancestor whose
  // text passed a length check — the whole contact section — so the question
  // came back as "First Name * Middle Name Last Name * Mobile Phone * Email *"
  // and nothing could match it to a stored answer.
  //
  // Only accepted when the ancestor holds exactly ONE label and ONE control:
  // that is a form-group wrapping a single question. Two of either means we
  // have climbed into a section and are guessing which label belongs to us.
  {
    let n = el.parentElement, hops = 0;
    while (n && hops < 4) {
      const labels = n.querySelectorAll('label');
      const controls = n.querySelectorAll('input,textarea,select,[contenteditable="true"]');
      if (labels.length === 1 && controls.length === 1) {
        const t = clean(labels[0].innerText);
        if (t) return t;
      }
      n = n.parentElement; hops++;
    }
  }

  let n = el.parentElement, hops = 0;
  while (n && hops < 4) {
    const c = n.cloneNode(true);
    c.querySelectorAll('input,textarea,select,button,script,style').forEach(x => x.remove());
    // The widget's own furniture is not its question. react-select renders the
    // placeholder, the chosen value and the dropdown arrow as ordinary divs
    // INSIDE the container, so a clone that keeps them reports "Select..." as
    // the label of every dropdown on the page.
    c.querySelectorAll(
      '[class*="placeholder" i],[class*="indicator" i],[class*="singleValue" i],' +
      '[class*="multiValue" i],[class*="menu" i],[role="listbox"],[role="option"],' +
      '[aria-hidden="true"]'
    ).forEach(x => x.remove());
    const t = clean(c.innerText);
    if (t.length > 8) return t;
    n = n.parentElement; hops++;
  }
  return clean(el.getAttribute('placeholder')) || clean(el.getAttribute('name'));
}
"""


# How long to wait for a dropdown's own list to render after it is opened.
# react-select mounts the menu in a portal on click; there is nothing to read
# before it does.
_MENU_WAIT_MS = int(os.environ.get("GRINDLY_COMBOBOX_MENU_WAIT_MS", "900"))


def _is_combobox(el) -> bool:
    """A text input that is really a dropdown.

    Greenhouse, Ashby and Lever all build their selects as a react-select
    combobox: a plain <input> with role=combobox, no options in the DOM until it
    is opened, and a placeholder of "Select..." where a question should be. Typed
    into like a text box it takes prose and the form rejects the submission —
    which is exactly how the first real application this system sent died.
    """
    try:
        if (el.get_attribute("role") or "").lower() == "combobox":
            return True
        # Some builds put the role on the wrapper and leave the input bare.
        return bool(el.evaluate(
            "e => !!(e.getAttribute('aria-expanded') !== null"
            " || e.closest('[role=combobox]')"
            " || (e.getAttribute('aria-autocomplete') === 'list'))"
        ))
    except Exception:  # noqa: BLE001
        return False


def _select_shell_ghost(el) -> bool:
    """An input react-select renders that is not a question.

    Every react-select mounts a second, empty input alongside its combobox —
    Greenhouse ships it as `class="...-requiredInput"` — purely so the browser's
    native validation can say "please fill out this field" when nothing is
    chosen. It has no name, no id, no label and no options, and it is REQUIRED.

    Read as a question it is unanswerable by construction, so every dropdown on
    the page produced a phantom required field that nothing could ever fill and
    that blocked the submit. Inside a select shell, only the combobox is real.
    """
    try:
        return bool(el.evaluate(
            """e => {
              if ((e.getAttribute('role') || '') === 'combobox') return false;
              if (/requiredInput/i.test(e.className || '')) return true;
              // A ghost has no name and no id — that is what makes it a ghost.
              // Matching on the wrapper alone was far too broad: '-container'
              // appears on ordinary layout divs, so on Keka a single dropdown
              // inside a wide wrapper made every real field in it invisible and
              // the form read as having no questions at all.
              if (e.getAttribute('name') || e.id) return false;
              // And only a CLOSE ancestor counts. Walking to any ancestor lets
              // one combobox anywhere on the page disqualify the whole form.
              let n = e.parentElement, hops = 0;
              while (n && hops < 3) {
                const cls = n.className || '';
                if (typeof cls === 'string'
                    && /select-shell|select__|css-.*-container/i.test(cls)
                    && n.querySelector('[role="combobox"]')) return true;
                n = n.parentElement; hops++;
              }
              return false;
            }"""
        ))
    except Exception:  # noqa: BLE001
        return False


def _wrapper_required(el) -> bool:
    """Is the dropdown this input belongs to marked required?

    The input itself never is. The vendor marks the field group instead — with
    aria-required, a `required` class, or an asterisk in the label.
    """
    try:
        return bool(el.evaluate(
            """e => {
              const g = e.closest('[class*="field" i],[class*="form" i],div');
              if (!g) return false;
              if (g.querySelector('[aria-required="true"]')) return true;
              if (/required/i.test(g.className || '')) return true;
              const lab = g.querySelector('label');
              return !!(lab && /\\*/.test(lab.innerText || ''));
            }"""
        ))
    except Exception:  # noqa: BLE001
        return False


def _combobox_options(page, el) -> list[str]:
    """Open the dropdown, read what it actually offers, close it again.

    There is no way to know a react-select's options without opening it: they do
    not exist in the DOM until the menu mounts. Costs one click per dropdown and
    a fraction of a second, on a handful of fields per form — cheap against the
    alternative, which is answering a question we cannot see the answers to.

    Leaves the page as it found it: the menu is dismissed with Escape, and
    nothing is selected.
    """
    try:
        el.click()
        page.wait_for_timeout(_MENU_WAIT_MS)
        options = page.evaluate(
            """() => {
              const seen = [];
              document.querySelectorAll('[role="option"]').forEach(o => {
                const t = (o.innerText || '').trim().replace(/\\s+/g, ' ');
                // "Select..." and friends are the widget telling you nothing is
                // chosen, not something a candidate can be.
                if (t && t.length < 120 && !seen.includes(t)) seen.push(t);
              });
              return seen;
            }"""
        ) or []
    except Exception as e:  # noqa: BLE001
        print(f"[questions] could not read a dropdown's options: {e}")
        options = []
    finally:
        try:
            page.keyboard.press("Escape")
            page.wait_for_timeout(120)
        except Exception:  # noqa: BLE001
            pass
    return [o for o in options if not _PLACEHOLDER_LABEL.match(o)]


def read_fields(page) -> list[dict]:
    """Every answerable field on the open apply form, paired with its question.

    Returns dicts of {el, kind, label, required, options}. Already-filled fields
    are excluded — the cover letter and the resume upload are handled by the
    caller, and re-typing over them would clobber real work.
    """
    fields: list[dict] = []
    try:
        # contenteditable is here for a reason that native validation cannot
        # cover for us. Modern ATSs render long-answer boxes ("Why this role?",
        # cover letters) as a rich-text editor — a <div contenteditable> with a
        # toolbar, not a <textarea>. Such a box is invisible to a
        # `textarea, input, select` query, AND the browser's own constraint
        # validation never reports it, because it is not a form control at all.
        # So an unanswered required rich-text question passed both of our
        # checks and was discovered only by the employer's own JS rejecting the
        # submit, after the click had been spent.
        els = page.query_selector_all(
            "textarea, input, select, [contenteditable='true'], [contenteditable='']"
        )
    except Exception as e:  # noqa: BLE001
        print(f"[questions] could not read the form: {e}")
        return []

    for el in els:
        try:
            tag = (el.evaluate("e => e.tagName") or "").lower()
            itype = (el.get_attribute("type") or "text").lower()
            name = el.get_attribute("name") or ""
            editable = _is_rich_text(el)

            # Answerable means a native form control or a live editor, and
            # nothing else. The selector above already implies this, but it is
            # the one assumption everything below rests on — every remaining
            # branch calls input_value() or reads .value — so state it rather
            # than inherit it from a string two hundred lines away.
            if tag not in ("input", "textarea", "select") and not editable:
                continue

            # A rich-text editor is a <div>, so the input-shaped guards below
            # (type, input_value, select defaults) do not apply to it and would
            # misread it if they ran.
            if not editable:
                if itype in ("hidden", "file", "submit", "button", "image", "reset"):
                    continue
                if _SKIP_NAMES.search(name):
                    continue
            # Off-screen inputs are not questions. react-select keeps a hidden
            # twin of every dropdown to carry its value, and Playwright will
            # patiently retry a click on one for a full minute before giving up
            # — 58 retries on a single field, in a run that has a whole form to
            # get through.
            try:
                if not el.is_visible():
                    continue
            except Exception:  # noqa: BLE001
                continue
            if _select_shell_ghost(el):
                continue
            if editable:
                # Same "already answered" rule, read the only way a div can be
                # read. Skipping this would clobber a cover letter the caller
                # had already written into the editor.
                if (el.evaluate("e => (e.innerText || '').trim()") or "").strip():
                    continue
            elif tag != "select" and (el.input_value() or "").strip():
                continue  # already answered (cover letter, prefilled profile data)
            # A <select> the FORM has already answered. Keka defaults its phone
            # country code to +91 and labels it with the whole contact section,
            # so we could neither read the question nor improve on the answer —
            # and reporting it as an unanswered required field blocked the submit
            # on every Keka application. A vendor's own default IS an answer; a
            # placeholder ("Select...") is not.
            if tag == "select":
                try:
                    chosen = (el.evaluate(
                        "e => e.selectedIndex >= 0"
                        " ? (e.options[e.selectedIndex].text || '') : ''"
                    ) or "").strip()
                except Exception:  # noqa: BLE001
                    chosen = ""
                if chosen and not _PLACEHOLDER_LABEL.match(chosen):
                    continue

            options: list[str] = []
            combobox = _is_combobox(el)
            if tag == "select":
                options = [
                    (o.inner_text() or "").strip()
                    for o in el.query_selector_all("option")
                ]
                options = [o for o in options if o]
            elif combobox:
                options = _combobox_options(page, el)

            fields.append({
                "el": el,
                "kind": (
                    "select" if tag == "select"
                    # A rich-text editor takes prose exactly like a textarea
                    # does, and every downstream rule that keys on "textarea"
                    # — the required-free-text fallback, the typed-input
                    # refusal — is the rule we want for it too. Calling it
                    # anything else would mean restating all of them.
                    else "textarea" if editable
                    else "combobox" if combobox
                    else "textarea" if tag == "textarea"
                    else itype
                ),
                "label": (el.evaluate(_LABEL_JS) or "").strip()[:300],
                # A react-select input is never marked `required` on the input
                # itself — the wrapper carries aria-required. Reading only the
                # attribute made every ATS dropdown look optional, so an
                # unanswered one sailed through to a submit the form rejected.
                "required": (
                    el.get_attribute("required") is not None
                    or (el.get_attribute("aria-required") or "").lower() == "true"
                    or _wrapper_required(el)
                ),
                "options": options,
            })
        except Exception:  # noqa: BLE001
            continue
    return fields


def _is_rich_text(el) -> bool:
    """Is this a contenteditable editor rather than a real form control?

    Checks the live `isContentEditable` property, not the attribute: editors
    commonly set it from JS after mount, and an inner node inherits editability
    from an ancestor without carrying the attribute itself. A <textarea> also
    reports true for `isContentEditable` in some engines, so native form
    controls are excluded explicitly — they already have a better path.
    """
    try:
        return bool(el.evaluate(
            "e => e.isContentEditable === true"
            " && !['INPUT','TEXTAREA','SELECT'].includes(e.tagName)"
        ))
    except Exception:  # noqa: BLE001
        return False


# A "label" that is really a widget's placeholder. Greenhouse, Ashby and Lever
# all build their dropdowns as a React combobox — a plain <input> with
# role=combobox and a placeholder of "Select..." or "Search" — so _LABEL_JS's
# last resort returns the placeholder and we hand a model a question that reads
# "Select...". It answered, in production, "I don't have information to select
# from", typed that into a REQUIRED dropdown, and the employer's form rejected
# the submission.
#
# The honest reading is that we could not find the question, which is a
# different thing from a question with no good answer: it stops the application
# for the candidate instead of filling the box with prose.
# What a dropdown says when it is NOT answered.
#
# read_fields skips a <select> whose selected option does not match this,
# because a vendor's own default (Keka's "+91", "INR") really is an answer and
# re-asking it blocked submits. The cost of a miss here is total and silent: the
# field is never offered to the answering engine, never filled, and the form's
# own validation rejects the submit with the field still empty.
#
# Measured on a live Keka form, which is the highest-yielding vendor we have.
# Its placeholder is "Select an option" — the old pattern required the string to
# END after "select", so it matched a bare "Select" and missed this. Every Keka
# dropdown was therefore read as already-answered:
#
#     gender            required  "Select an option"  -> skipped, blocks submit
#     eligibletowork    required  "Select an option"  -> skipped
#     nationality                 "Select an option"  -> skipped
#     locationPreference          "Select an option"  -> skipped
#
# So it now allows the trailing noun phrase every ATS puts there, while still
# refusing to treat a real value as a placeholder — "0" for months of experience
# and "INR" for a currency are answers, and must keep being left alone.
_PLACEHOLDER_LABEL = re.compile(
    # Dashes alone — "--", "———" — are their own placeholder, not decoration
    # around a word. Losing this alternative when the pattern was widened let a
    # bare "--" through as a real option, and the answering engine wrote a
    # sentence about Python into it.
    r"^\s*[-–—]{2,}\s*$"
    r"|"
    r"^\s*(?:[-–—]{2,}\s*)?"
    r"(?:please\s+)?"
    r"(?:select|search|choose|pick|type to search|start typing)"
    r"(?:\s+(?:an?|one|your|the)?\s*"
    r"(?:option|item|value|choice|answer)?)?"
    r"\s*[.…]{0,3}\s*(?:[-–—]{2,})?\s*$",
    re.I,
)

# Input kinds that can only accept a specific shape of value. A model's prose is
# never one of them: "I don't have a specific end date to provide" went into a
# `number` box for "End date year*", which is both nonsense to a recruiter and
# an instant client-side validation failure — the one that killed the first real
# submission this system ever attempted.
_TYPED_INPUTS = ("number", "date", "month", "week", "time", "search", "range", "color")


# A label that is several questions stuck together, not one.
#
# When the ancestor walk finds no single question it eventually returns a whole
# section: "First Name * Middle Name Last Name * Mobile Phone * Email *". That
# blob was matched by the phone pattern, so a REQUIRED field on every Keka form
# got the phone number handed to a dropdown — and when it was refused, blocked
# the submit on all four of them.
#
# Two asterisks is the tell: a form marks one required field with one star, so a
# label carrying several has swallowed several fields.
_LABEL_IS_A_SECTION = re.compile(r"\*[^*]{0,80}\*")


def unreadable_label(label: str) -> bool:
    """True when what we scraped is not this field's question.

    Either the widget's own placeholder, or a run of several questions the label
    walk gave up and returned whole. Both mean the same thing: we do not know
    what is being asked, so we must not answer it.
    """
    text = (label or "").strip()
    if not text or _PLACEHOLDER_LABEL.match(text):
        return True
    return bool(_LABEL_IS_A_SECTION.search(text))


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
# An open question about the candidate's own work, which the model MAY answer.
#
# _FACTUAL_CLAIM below exists to stop a model asserting a credential — "Do you
# have 2+ years of Django?" answered "Yes" is a fabricated qualification. But it
# also caught "What ML algorithms have you used?" and "How did you evaluate your
# model?", which are not claims to be granted or denied: they are asking the
# candidate to describe work their resume already describes, and refusing them
# cost a whole application over three boxes the resume answers on its own.
#
# The line is the grammar. "Do you / have you / are you" invites a verdict on a
# fact; "what / how / which / describe / explain" invites an account of it, and
# rule 2 of this module is that the model may phrase what the candidate already
# claims. Only ever applied to free text — a yes/no box has no room for an
# account, and a numeric one has none either.
_OPEN_QUESTION = re.compile(
    r"^\s*(what|how|which|why|where|describe|explain|tell\s+us|walk\s+us|share|list|give\s+(us|an)|elaborate)\b",
    re.I,
)


def model_may_describe(label: str, kind: str) -> bool:
    """Is this an open question about their own work, in a box with room for one?"""
    if kind not in ("textarea", "text"):
        return False
    return bool(_OPEN_QUESTION.match((label or "").strip()))


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
# "Graduation Month & Year (Completed / Expected)" — one box, two facts. Keka
# asks it as required, and answering it with the year alone leaves a form
# reading "2027" where it asked for a month too. Both or neither.
_GRAD_MONTH_YEAR_Q = re.compile(
    r"\bgraduat\w*\s+month\s*(&|and|/)?\s*year\b|"
    r"\bmonth\s*(&|and|/)\s*year\s+of\s+(graduation|passing)\b",
    re.I,
)
_MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def _grad_month_year(profile: dict) -> str:
    """"May 2027" — the month and the year, or nothing.

    A form asking for both and given only the year has been answered wrongly,
    not partially, so a missing month refuses the whole box and setup asks for
    it once."""
    year = str(profile.get("grad_year") or "").strip()
    if not year or year in ("0", "None"):
        return ""
    raw = str(profile.get("grad_month") or "").strip()
    if not raw:
        return ""
    name = raw
    if raw.isdigit():
        n = int(raw)
        if not 1 <= n <= 12:
            return ""
        name = _MONTH_NAMES[n - 1]
    return f"{name} {year}"


_GRAD_YEAR_Q = re.compile(
    r"\b(graduation\s+year|year\s+of\s+(graduation|passing)|passing\s*(-|\s)?out\s+year|"
    r"passing\s+year|batch\s+year|when\s+do\s+you\s+graduate|expected\s+graduation|"
    # Greenhouse's education block asks it as "End date year" against the
    # degree. It is the same fact, it is required, and leaving it blank stopped
    # a real application on a number we already held.
    r"end\s+date\s+year|end\s+year)\b",
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

# "Total Years of Experience *" / "Relevant Years of Experience *" / "Experience
# (in years)". Required boxes on Keka and Darwinbox, and until now nothing could
# answer them: measured on a real application to Dash Technologies, the agent
# refused to guess and stopped at the submit button — correctly, and it would
# have done so on every form asking this, forever.
#
# Deliberately does NOT match "work experience" as a section heading or a
# free-text "describe your experience" box; those want prose, and this answer is
# a number.
_YEARS_EXPERIENCE_Q = re.compile(
    r"\b(?:total|relevant|overall|professional|work)?\s*"
    r"(?:years?|yrs?)\s+of\s+(?:work\s+)?experience\b|"
    # "Experience (in years)" — the parenthesis and the "in" are both optional
    # and can appear together, which a plain either/or missed.
    r"\bexperience\s*\(?\s*(?:in\s+)?(?:years?|yrs?)\b|"
    r"\byears?\s+experience\b",
    re.I,
)
_PREV_INTERNSHIP_Q = re.compile(
    r"\b(previous|prior|past|any)\s+internship\b|"
    r"\binternship\s+experience\b|"
    r"\bhave\s+you\s+(ever\s+)?(done|completed|had|interned)\b[^?]{0,40}\bintern",
    re.I,
)
# How many DAYS until you can start. Keka asks "Available To Join (in days)" as a
# required numeric box, and the answer we hold is a phrase — "Immediately",
# "Within 2 weeks". Converting the candidate's own answer into the unit the form
# demands is not inventing anything; refusing to, and blocking the application
# over a unit, is just a worse way to be right.
_JOIN_DAYS_Q = re.compile(
    r"\b(available\s+to\s+join|joining|join)\b[^\n]{0,24}\bdays?\b|"
    r"\bdays?\s+to\s+join\b|\bnotice\s+period\b[^\n]{0,16}\bdays?\b",
    re.I,
)
_DAYS_FOR_PHRASE = (
    ("immediate", "0"),
    ("right away", "0"),
    ("2 week", "14"), ("two week", "14"), ("15 day", "15"), ("fortnight", "14"),
    ("1 month", "30"), ("one month", "30"), ("4 week", "30"),
    ("2 month", "60"), ("two month", "60"),
    ("3 month", "90"), ("three month", "90"),
)


def _current_salary(profile: dict) -> str:
    """What the candidate currently earns, as a figure a salary box will take.

    Setup asks this as "Are you earning right now?" and offers "Not earning — I
    am a student", because a bare 0 reads like a placeholder to somebody who has
    never been paid. That phrasing is right for the person and wrong for the
    employer: measured on a live Keka application, the sentence itself was typed
    into `Current Salary *`, which is a numeric box.

    So the same treatment as _years_experience: keep the friendly label in
    setup, hand the form the number. "Not earning" IS zero — that is what the
    user said, not an assumption — and anything the user typed themselves is
    passed through untouched.
    """
    raw = str(profile.get("current_salary") or "").strip()
    if not raw:
        return ""
    if re.search(r"\bnot\s+earning\b|\bno\s+(?:current\s+)?(?:salary|income)\b"
                 r"|\bunemployed\b|\bstudent\b", raw, re.I):
        return "0"
    m = re.search(r"\d[\d,]*", raw)
    return m.group(0).replace(",", "") if m else raw


def _years_experience(profile: dict) -> str:
    """The candidate's stated years of full-time experience, as a bare number.

    Setup offers "0 — no full-time work yet" as the first option, because the
    plain digit reads like a placeholder to a student who has never worked. The
    employer's box wants the digit, so take it back out.

    Returns "" when the user has not answered, which is what makes the form stop
    and ask rather than send a guess. Zero is a FACT about a person — someone
    who worked two years before a masters would have it written wrong under
    their own name — so it is never assumed here.
    """
    raw = str(profile.get("years_experience") or "").strip()
    if not raw:
        return ""
    m = re.search(r"\d+", raw)
    return m.group(0) if m else ""


def _join_in_days(profile: dict) -> str | None:
    """The stored start-date answer, in days. None when we hold nothing usable —
    "After my current semester" has no day count that would not be a guess."""
    for key in ("availability", "notice_period"):
        raw = str(profile.get(key) or "").strip().lower()
        if not raw:
            continue
        digits = re.search(r"\b(\d{1,3})\s*days?\b", raw)
        if digits:
            return digits.group(1)
        for phrase, days in _DAYS_FOR_PHRASE:
            if phrase in raw:
                return days
    return None


_NOTICE_Q = re.compile(
    r"\bnotice\s+period\b|\bhow\s+soon\s+can\s+you\s+join\b|\bjoining\s+time\b",
    re.I,
)
_PREFERRED_LOCATION_Q = re.compile(
    r"\b(preferred|desired|willing\s+to\s+work\s+in)\s*(location|city|place)\b|"
    r"\blocation\s+preference\b|\bpreferred\s+work\s+location\b",
    re.I,
)


def _first_preferred_location(profile: dict) -> str:
    """The top location the candidate chose. A form asks for one; the list is
    theirs and its first entry is the one they put first."""
    raw = profile.get("preferred_locations")
    try:
        items = raw if isinstance(raw, list) else json.loads(raw or "[]")
    except (TypeError, ValueError):
        return ""
    for item in items:
        text = str(item or "").strip()
        if text:
            return text
    return ""


_CURRENT_LOCATION_Q = re.compile(
    r"\b(current|present)\s+(location|city|residence|address)\b|"
    r"\bwhere\s+are\s+you\s+(currently\s+)?(based|located|living)\b|"
    r"\bcity\s+of\s+residence\b|"
    # "Location (City)*" and a bare "City" — Greenhouse's phrasing, and the
    # second thing a live AlphaGrep application stopped on with the answer
    # already on file. Deliberately not a bare \blocation\b: "Preferred
    # Location" and "Job Location" are different questions, and both are
    # matched by their own patterns before this one is consulted.
    r"^\s*location\s*\(\s*city\s*\)|^\s*city\s*\*?\s*$",
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
# Deliberately a different question from nationality, and deliberately matched
# after it: "Country of citizenship" is a nationality box, while a bare
# "Country" asks where the candidate is applying from. Neither is derivable from
# the other — "Indian" is not what a country dropdown wants, and a candidate can
# hold one and live in the other — so a model answered it "India" on a real
# Greenhouse form: plausible, unverified, stated under their name.
_COUNTRY_Q = re.compile(r"^\s*country\b(?!\s+of\s+citizenship)", re.I)
# "School" is what Greenhouse and Lever call the college box, and it was the
# one common word missing here — measured on a live AlphaGrep application, which
# reached the submit button and stopped on "School*" while the answer sat in the
# profile under `college`.
#
# Bounded to the box that asks for a NAME. "School" also appears in "High School
# Percentage" and "Schooling", which are different facts with their own answers,
# so those keep their own patterns ahead of this one.
_COLLEGE_Q = re.compile(
    r"\b(college|university|institute|institution)\b|"
    r"\bschool\s*(?:name|attended)?\s*\*?$|"
    r"\b(?:name\s+of\s+(?:your\s+)?)?school\b(?!\s*(?:percent|%|marks|grade|board))",
    re.I,
)
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
_MIDDLE_NAME = re.compile(r"\bmiddle\s*name\b", re.I)

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
    # "Experience (in years)" is a NUMBER box, and a model handed it
    # "I have around 2-3 years of experience, as indicated by my..." on a live
    # Keka form, which the field mangled into "0232021". Any label naming its
    # own unit in years/months is asking for a figure, never for prose.
    r"in\s+years|in\s+months|years?\s+of\s+experience|experience\s*\(|"
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
    if _MIDDLE_NAME.search(label):
        # Three names means the middle one is the middle name; two means there
        # is no middle name and the box stays empty. A model asked this produced
        # "Sakthi" off the resume — correct, and still an identity fact arriving
        # from an LLM, which is the one thing this module exists to prevent.
        return parts[1] if len(parts) >= 3 else None
    if _LAST_NAME.search(label):
        # With a middle name present, the surname is the LAST word, not
        # everything after the first — "Sakthi Mahendhar" is not a surname.
        return parts[-1] if len(parts) > 1 else None
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


def _setup_candidates(label: str, profile: dict) -> list[tuple[bool, str, str]]:
    """(this pattern matches, which stored fact answers it, its current value).

    One table, two readers. `_from_setup` takes the first row that matches AND
    has a value; `missing_fact_for` takes the first that matches and has NONE —
    which is the difference between "the agent could not read this form" and
    "the user never told us this about themselves". Those two failures look
    identical on a dashboard and need completely different fixes, so they must
    not be derived from two drifting copies of this list.
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

    def _num_or_zero(key: str) -> str:
        """Same, for the one numeric column where 0 is a real answer."""
        value = profile.get(key)
        if value in (None, ""):
            return ""
        if isinstance(value, float) and value.is_integer():
            return str(int(value))
        return str(value)

    # Order matters throughout: "Which college/university?" also matches
    # _DEGREE_Q on "course", and the college is the more specific answer. The
    # school-level percentages come before the grade/percentage catch-alls for
    # the same reason.
    candidates: list[tuple[bool, str, str]] = [
        (bool(_SPONSORSHIP_Q.search(label)), "needs_sponsorship", _text("needs_sponsorship")),
        # Ahead of the stipend and start-date patterns below, which both claim
        # some of the same words: "current salary" is not "expected salary", and
        # "notice period" is its own box on forms that also ask when you start.
        (bool(_CURRENT_SALARY_Q.search(label)), "current_salary", _current_salary(profile)),
        # Ahead of the generic numeric patterns: this box wants a count of
        # years, and the stored answer already IS one.
        (bool(_YEARS_EXPERIENCE_Q.search(label)), "years_experience",
         _years_experience(profile)),
        (bool(_PREV_INTERNSHIP_Q.search(label)), "previous_internship", _text("previous_internship")),
        # Before _NOTICE_Q and _START_Q: both match this label too, and both
        # would hand a phrase to a numeric box.
        (bool(_JOIN_DAYS_Q.search(label)), "availability", _join_in_days(profile) or ""),
        (bool(_NOTICE_Q.search(label)), "notice_period", _text("notice_period")),
        (bool(_CURRENT_LOCATION_Q.search(label)), "current_location", _text("current_location")),
        # Where they want to WORK, which is a different question from where they
        # live and is asked as its own required box on Indian portals. Their
        # preferred locations are a list; a form wants one, and the first is the
        # one they ranked highest.
        (bool(_PREFERRED_LOCATION_Q.search(label)), "preferred_locations",
         _first_preferred_location(profile)),
        (bool(_GENDER_Q.search(label)), "gender", _text("gender")),
        (bool(_DOB_Q.search(label)), "date_of_birth", _text("date_of_birth")),
        (bool(_DISABILITY_Q.search(label)), "differently_abled", _text("differently_abled")),
        (bool(_NATIONALITY_Q.search(label)), "nationality", _text("nationality")),
        (bool(_COUNTRY_Q.search(label)), "country", _text("country")),
        # A percentage only answers a question that ASKS for one. "Class 12 board
        # name" and "Intermediate college" match the school-level pattern too,
        # and a percentage typed into either is nonsense.
        (bool(_CLASS10_Q.search(label) and _PERCENT_Q.search(label)),
         "class10_percent", _num("class10_percent")),
        (bool(_CLASS12_Q.search(label) and _PERCENT_Q.search(label)),
         "class12_percent", _num("class12_percent")),
        (bool(_LINKEDIN_Q.search(label)), "linkedin_url", _text("linkedin_url")),
        (bool(_GITHUB_Q.search(label)), "github_url", _text("github_url")),
        # A required "Portfolio Link *" stopped a real application for a student
        # who has no personal site — most don't. The question a recruiter is
        # asking is "where can I see your work", and for that student the honest
        # answer is their GitHub. It is their own stored URL, not an invention,
        # so this stays inside the never-guess rule. Their own site still wins
        # when they have one, and someone with neither still stops the form.
        (bool(_PORTFOLIO_Q.search(label)), "portfolio_url",
         _text("portfolio_url") or _text("github_url")),
        # Before _GRAD_YEAR_Q, which matches this label too and would answer
        # a "month & year" box with a bare year.
        (bool(_GRAD_MONTH_YEAR_Q.search(label)), "grad_month", _grad_month_year(profile)),
        (bool(_GRAD_YEAR_Q.search(label)), "grad_year", _num("grad_year")),
        (bool(_HOURS_Q.search(label)), "hours_per_week", _num("hours_per_week")),
        # Zero is an ANSWER here, not the empty marker every other numeric column
        # uses. Nobody scored 0% in class 12, but "0" is the first option in the
        # stipend list and it is a student saying they will take an unpaid
        # internship. Read through `_num`, that answer vanished: setup accepted
        # the pick, the column held 0, and every form asking "Expected Salary *"
        # was still refused for a fact the user had already given.
        (bool(_STIPEND_Q.search(label)), "expected_stipend",
         _num_or_zero("expected_stipend")),
        (bool(_START_Q.search(label)), "availability", _text("availability")),
        (bool(_RELOCATE_Q.search(label)), "willing_to_relocate", _text("willing_to_relocate")),
        (bool(_WORK_AUTH_Q.search(label)), "work_authorization", _text("work_authorization")),
        # Never on a school-level question. "Intermediate college name" and
        # "Class 12 stream" match these patterns and are asking about the
        # candidate's SCHOOL — answering them with the university and the B.Tech
        # states two facts that aren't true, on a form, under their name.
        # No `education` fallback here. That column is the combined "course and
        # college" line, and on older accounts it often holds only the course —
        # seen live, a "College name" box was answered "B.Tech". Better to stop
        # and ask than to write the degree where the college goes.
        (bool(_COLLEGE_Q.search(label) and not _SCHOOL_LEVEL.search(label)),
         "college", _text("college")),
        (bool(_DEGREE_Q.search(label) and not _SCHOOL_LEVEL.search(label)),
         "degree", _text("degree") or _text("education")),
    ]
    return candidates


def _from_setup(label: str, field: dict, profile: dict) -> str | None:
    """Answers the user gave in setup, matched to the question being asked.

    Nothing here is derived, inferred, or phrased by a model — each one is a
    value the user typed or picked, returned verbatim. A fact we do not hold
    returns None and the application stops for them, exactly as before.
    """
    for matches, _key, value in _setup_candidates(label, profile):
        if matches and value:
            # Stripped here as well as at the write (src/app/api/profile), because
            # rows saved before that trim existed still carry the stray space —
            # and this value goes into a free-text box verbatim, where
            # `_fit_option` has no option list to normalise it against.
            return _fit_option(field, str(value).strip())
    return None


def missing_fact_for(label: str, profile: dict) -> str:
    """Which stored fact WOULD have answered this question, but is empty?

    "" when the question is not one setup collects — that is a form the agent
    could not read, which is its own problem to fix. A name here means the
    opposite: the agent knew exactly what was being asked and had nothing true
    to say, because nobody has ever told it. Only the user can fix that one, and
    they can fix it for every future application at once.
    """
    for matches, key, value in _setup_candidates(label, profile):
        if matches and not value:
            return key
    return ""


def _shaped_for(field: dict, answer: str | None) -> str | None:
    """Drop an answer the field cannot physically accept.

    The deterministic pass answers by matching the QUESTION, which says nothing
    about the shape of the box. Two ways that went wrong on real forms:

      * "Available To Join (in days)" is a `number` input, and _CONFIRM read
        "available to join" as a yes/no — so the literal string "Yes" was typed
        into a numeric box. That is the same fault that got the first real
        application this system sent rejected, arriving by a different route.
      * A `select` for a phone country code sits under the label "Mobile Phone",
        so the phone number itself was handed to select_option(), which throws
        because no option reads "8096267553".

    A dropped answer leaves the field empty, which the required-field check then
    reports honestly. Anything is better than a value the form will reject after
    the point of no return.
    """
    if answer is None or answer == "__check__":
        return answer
    kind = field.get("kind")
    if kind in ("number", "range"):
        # A number box takes a number. Nothing else, however true.
        cleaned = str(answer).strip().replace(",", "")
        try:
            float(cleaned)
        except ValueError:
            return None
        return cleaned
    if kind in ("select", "combobox"):
        # Must be one of the field's OWN options, or it cannot be chosen at all.
        return _fit_option(field, str(answer))
    return answer


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
        and kind not in ("textarea", "select", "combobox")
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
        det = _shaped_for(f, _deterministic(f, profile, name, email))
        if det is not None:
            out.append({
                "question": f["label"], "answer": det,
                "source": "profile", "kind": f["kind"], "_i": i,
            })
            continue

        if f["kind"] in ("select", "combobox"):
            # Only an affirmative option. See _pick_option for why "first real
            # choice" was removed: it turned every preference question into an
            # invented fact, and every rating scale into a 1-out-of-5.
            pick = _pick_option(f)
            out.append({
                "question": f["label"], "answer": pick or "",
                "source": "default" if pick else "unanswerable", "kind": f["kind"], "_i": i,
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
        if (
            _WANTS_A_DATUM.search(f["label"] or "")
            or (
                _FACTUAL_CLAIM.search(f["label"] or "")
                # ...unless it is an open question about their own work, which
                # the model may describe from the resume. See model_may_describe.
                and not model_may_describe(f["label"], f["kind"])
            )
        ):
            out.append({
                "question": f["label"], "answer": "",
                "source": "unanswerable", "kind": f["kind"], "_i": i,
            })
            continue

        # Two more shapes the model must never be asked to fill, both learned
        # from the first real submission, both of which it answered fluently and
        # wrongly:
        #
        #   * a box whose question we could not read (a combobox placeholder —
        #     "Select...", "Search"). Answering it is answering a question
        #     nobody asked.
        #   * an input that only accepts a number, a date or a search term.
        #     Prose in a `number` box fails validation before a human ever sees
        #     it, and the application dies with no explanation.
        #
        # Both stop here as unanswerable, so a REQUIRED one blocks the submit
        # and reaches the candidate instead of the employer.
        #   * a question SETUP knows how to ask but we hold no answer for. The
        #     deterministic pass above already returned any stored value, so
        #     reaching here means the box is genuinely empty — and a model
        #     filling it invents precisely the class of fact this module exists
        #     to refuse. It answered "Country*" with "India" from the résumé
        #     alone: plausible, unverified, and stated under the candidate's
        #     name. missing_fact_for names which one, so the user can fill it
        #     once and never see it again.
        if (
            unreadable_label(f["label"])
            or f["kind"] in _TYPED_INPUTS
            or missing_fact_for(f["label"] or "", profile)
            # Any name box. The deterministic pass above answers the ones we can
            # split out of the stored name; whatever is left is still the
            # candidate's identity and is not a model's to compose.
            or _FIRST_NAME.search(f["label"] or "")
            or _MIDDLE_NAME.search(f["label"] or "")
            or _LAST_NAME.search(f["label"] or "")
            or _NAME_SELF.search(f["label"] or "")
        ):
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
        if _WANTS_A_DATUM.search(label_l) or (
            _FACTUAL_CLAIM.search(label_l) and not model_may_describe(label_l, rec["kind"])
        ):
            continue
        # Same exclusion as the answering pass above, and for the same reason:
        # a box whose question we could not read is not a box we may put a
        # paragraph in. Without this the refusal above is undone one loop later
        # — the field ends up holding "My background is in python…" under the
        # label "Select...", which is how a required dropdown gets prose typed
        # into it and the whole submission is rejected.
        if (
            unreadable_label(label_l)
            or rec["kind"] in _TYPED_INPUTS
            or missing_fact_for(label_l, profile)
            # Name boxes too, same reason: the answering pass refuses to let a
            # model compose the candidate's identity, and this loop was undoing
            # that refusal — a live Greenhouse application went out with the
            # generic paragraph as the candidate's "Last Name*" (the stored
            # name was one word, so the deterministic split had no surname).
            or _FIRST_NAME.search(label_l)
            or _MIDDLE_NAME.search(label_l)
            or _LAST_NAME.search(label_l)
            or _NAME_SELF.search(label_l)
        ):
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

def _choose_in_combobox(page, el, value: str) -> bool:
    """Pick `value` from a react-select dropdown. True only if it stuck.

    Open, narrow the list by typing (these menus virtualise, so the option you
    want may not be mounted until you filter for it), click the option whose
    text matches, then CHECK. The check is the point: a click that lands on a
    menu which has already re-rendered silently selects nothing, and a dropdown
    that looks answered but is empty is exactly the state that gets a whole
    application rejected on submit.
    """
    wanted = (value or "").strip()
    if not wanted:
        return False
    try:
        el.click()
        page.wait_for_timeout(250)
        # Typing filters; it does not commit. Kept short so a stored answer that
        # is merely a prefix of the option ("Yes" for "Yes, immediately") still
        # narrows to it rather than to nothing.
        try:
            el.fill("")
            el.type(wanted[:24], delay=25)
            page.wait_for_timeout(_MENU_WAIT_MS)
        except Exception:  # noqa: BLE001
            page.wait_for_timeout(_MENU_WAIT_MS)

        picked = page.evaluate(
            """(want) => {
              const norm = s => (s || '').trim().replace(/\\s+/g, ' ').toLowerCase();
              const target = norm(want);
              const opts = Array.from(document.querySelectorAll('[role="option"]'));
              let hit = opts.find(o => norm(o.innerText) === target);
              if (!hit) hit = opts.find(o => norm(o.innerText).startsWith(target));
              if (!hit) hit = opts.find(o => target.startsWith(norm(o.innerText)));
              if (!hit) return false;
              hit.scrollIntoView({block: 'nearest'});
              hit.click();
              return true;
            }""",
            wanted,
        )
        if not picked:
            page.keyboard.press("Escape")
            return False
        page.wait_for_timeout(250)

        # Did it actually take? react-select writes the chosen label into the
        # container as its single value; an input that is still empty and a
        # container that still shows the placeholder mean the click did nothing.
        return bool(el.evaluate(
            """(e) => {
              const box = e.closest('[class*="control" i]') || e.parentElement;
              const shown = (box ? box.innerText : '').trim();
              if (!shown) return false;
              return !/^(select\\.{0,3}|search|choose)$/i.test(shown);
            }"""
        ))
    except Exception as e:  # noqa: BLE001
        print(f"[questions] combobox interaction failed: {e}")
        try:
            page.keyboard.press("Escape")
        except Exception:  # noqa: BLE001
            pass
        return False


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
            elif f["kind"] == "combobox":
                if not _choose_in_combobox(page, el, val):
                    # Not filled, and deliberately not typed into either. A
                    # react-select left holding raw text submits nothing and the
                    # form rejects the whole application; leaving it empty makes
                    # the required-field check stop us first, which is the
                    # outcome the candidate can actually act on.
                    print(f"[questions] could not pick {val!r} in {f['label'][:40]!r}")
                    continue
            else:
                typer(page, el, val)
            filled += 1
        except Exception as e:  # noqa: BLE001
            print(f"[questions] could not fill {f['label'][:40]!r}: {e}")
    return filled


# --- checking it before we send it ------------------------------------------

# What a control is actually holding right now, read off the live DOM.
#
# `input_value()` is not enough for a react-select: once an option is chosen the
# combobox input is CLEARED and the chosen label is rendered as a div inside the
# control. Reading the input alone reports every answered dropdown as empty.
_LIVE_VALUE_JS = """
e => {
  const clean = s => (s || '').trim().replace(/\\s+/g, ' ');
  const tag = e.tagName.toLowerCase();
  if (tag === 'select') {
    return e.selectedIndex >= 0 ? clean(e.options[e.selectedIndex].text) : '';
  }
  // A rich-text editor holds its answer as text, not as .value. Without this
  // branch every filled contenteditable reads back empty, and the pre-submit
  // gate would refuse an application that is in fact complete.
  if (e.isContentEditable === true) return clean(e.innerText);
  const type = (e.getAttribute('type') || 'text').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return e.checked ? 'on' : '';
  if (type === 'file') return (e.files && e.files.length) ? e.files[0].name : '';
  const v = clean(e.value);
  if (v) return v;
  const box = e.closest('[class*="control" i]')
           || e.closest('[class*="container" i]')
           || e.parentElement;
  if (box) {
    const c = box.cloneNode(true);
    c.querySelectorAll(
      '[class*="placeholder" i],[class*="indicator" i],[role="listbox"],[role="option"]'
    ).forEach(x => x.remove());
    const shown = clean(c.innerText);
    if (shown && !/^(select\\.{0,3}|select…|search|choose|--+)$/i.test(shown)) return shown;
  }
  return '';
}
"""


# An UNSOLVED captcha widget on the form we are about to submit.
#
# Detected by the presence of a real widget whose response TOKEN is still
# empty, never by keyword-matching the page text. That distinction is the whole
# design: an earlier text-based check ("does this page say captcha?") refused
# seven of eight perfectly good applications, because ATS pages mention captcha
# in their privacy blurb and cookie notice. A token, by contrast, is unambiguous
# — the vendor's own widget writes it on success, so empty means unsolved and
# non-empty means solved.
#
# Measured: Botsync's Workable form filled completely, passed every
# required-field check, and was clicked — into an unticked Cloudflare
# "Verify you are human" box. The button sat on "Submitting…" forever and the
# application was recorded as a failure, having spent a real daily slot.
#
# We do not, and must not, solve these. The point is to stop BEFORE the click
# so the slot is refunded and the listing is handed to the user's own browser,
# which has a person and a residential IP.
_CAPTCHA_JS = """
() => {
  const widgets = [
    // [token field, widget container]
    ['input[name="cf-turnstile-response"]', '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'],
    ['textarea#g-recaptcha-response, textarea[name="g-recaptcha-response"]', '.g-recaptcha, iframe[src*="/recaptcha/"]'],
    ['textarea[name="h-captcha-response"]', '.h-captcha, iframe[src*="hcaptcha.com"]'],
  ];
  const names = {0: 'Cloudflare human check', 1: 'reCAPTCHA', 2: 'hCaptcha'};
  for (let i = 0; i < widgets.length; i++) {
    const [tokenSel, boxSel] = widgets[i];
    const box = document.querySelector(boxSel);
    if (!box) continue;
    // A widget that is present but hidden is not being asked of us.
    const r = box.getBoundingClientRect ? box.getBoundingClientRect() : null;
    if (r && r.width === 0 && r.height === 0) continue;
    const token = document.querySelector(tokenSel);
    // No token field at all means we cannot tell it is solved; treat the
    // visible widget as blocking rather than guessing our way past it.
    if (!token || !(token.value || '').trim()) return names[i];
  }
  return '';
}
"""


def unsolved_captcha(page) -> str:
    """The name of a visible, unsolved captcha on this page, or ''.

    Fails OPEN (returns '') if the page cannot be read: a detector that
    blocked every application whenever evaluation hiccuped would be worse than
    the problem it solves.
    """
    try:
        return (page.evaluate(_CAPTCHA_JS) or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def live_value(el) -> str:
    """What this field is holding after we filled it. '' when still empty."""
    try:
        return (el.evaluate(_LIVE_VALUE_JS) or "").strip()
    except Exception:  # noqa: BLE001
        return ""


# Every control the browser's own constraint validation would refuse, with the
# question it belongs to. This is precisely the check that fires when a submit
# button is pressed, so asking it BEFORE the press tells us the outcome without
# spending the click.
#
# Scoped to the form the submit button lives in when we have one: an ATS page
# carries other forms (search boxes, newsletter sign-ups) whose required fields
# have nothing to do with this application.
_BLOCKERS_JS = """
(anchor) => {
  const clean = s => (s || '').trim().replace(/\\s+/g, ' ');
  const root = (anchor && anchor.closest('form')) || document;
  const labelFor = e => {
    const by = e.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\\s+/).map(id => document.getElementById(id))
        .filter(Boolean).map(n => clean(n.innerText)).filter(Boolean).join(' ');
      if (t) return t;
    }
    if (e.id) {
      const l = document.querySelector('label[for="' + CSS.escape(e.id) + '"]');
      if (l && clean(l.innerText)) return clean(l.innerText);
    }
    const wrap = e.closest('label');
    if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
    let n = e.parentElement, hops = 0;
    while (n && hops < 3) {
      const l = n.querySelector('label');
      if (l && clean(l.innerText)) return clean(l.innerText);
      n = n.parentElement; hops++;
    }
    return clean(e.getAttribute('aria-label'))
        || clean(e.getAttribute('placeholder'))
        || clean(e.getAttribute('name'))
        || e.id || '(unlabelled field)';
  };
  const out = [], seen = new Set();
  root.querySelectorAll('input,select,textarea').forEach(e => {
    if (e.disabled) return;
    const t = (e.getAttribute('type') || '').toLowerCase();
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return;
    let bad = false, why = '';
    try {
      // Hidden inputs are barred from constraint validation by the spec, so this
      // never fires on plumbing. It DOES fire on react-select's opacity:0
      // requiredInput, which is exactly the blocker we most need to see.
      if (typeof e.checkValidity === 'function' && !e.checkValidity()) {
        bad = true;
        why = clean(e.validationMessage) || 'required';
      }
    } catch (err) { return; }
    if (!bad) return;
    const lab = labelFor(e).slice(0, 70);
    const key = lab + '|' + why;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(lab + ' — ' + why);
  });
  return out.slice(0, 8);
}
"""


def form_blockers(page, submit_el=None) -> list[str]:
    """What would stop this submit, asked before the click instead of after.

    Six real applications were clicked through and rejected with "page shows a
    validation/error message". Every one of them had spent the user's daily slot
    and burned the idempotency claim, and none said which field was wrong. The
    page knew the whole time: the browser can be asked which controls fail
    validation, and it answers with the vendor's own message.

    Returns human-readable "<question> — <what is wrong>" strings, empty when the
    form is ready to go.
    """
    try:
        if submit_el is not None:
            return list(submit_el.evaluate(_BLOCKERS_JS) or [])
        return list(page.evaluate(_BLOCKERS_JS, None) or [])
    except Exception as e:  # noqa: BLE001
        print(f"[questions] could not read the form's validation state: {e}")
        return []


def unfilled_required(fields: list[dict]) -> list[str]:
    """Required fields we read that are STILL empty after filling.

    The pre-fill check in each channel tests the answers we *intended* to write;
    this tests what the form is actually holding. They come apart whenever
    `fill` gives up on a control — a react-select whose option never matched
    returns False and moves on, so a form that looked fully answered goes to
    submit with a required dropdown empty. That gap is the difference between a
    refusal the candidate can act on and a rejected application they cannot.
    """
    still: list[str] = []
    for f in fields:
        if not f.get("required"):
            continue
        if live_value(f["el"]):
            continue
        still.append((f.get("label") or "(unlabelled)")[:70])
    return still


def to_record(answers: list[dict]) -> str:
    """JSON for the applications table — what was asked, what we said, and whether
    a human fact or a model produced it. Stripped of element handles."""
    return json.dumps([
        {"q": a["question"], "a": a["answer"], "source": a["source"]}
        for a in answers
        if a["answer"]
    ])
