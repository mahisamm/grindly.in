"""ATS channel — submit to the employer's own applicant-tracking portal.

Why this is a different risk class from a board adapter
------------------------------------------------------
Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Zoho and friends host the
*employer's* public intake page. The candidate has no account there; the page
exists to receive applications from strangers. So unlike internshala.py there
is nothing to log into, nothing to rate-limit against a user's
identity, and nothing that can be banned. `resolver.py` already classifies these
as Tier A for exactly that reason — this module is the sender that Tier A was
missing, and until it existed an ATS-routed listing was resolved correctly and
then banked undelivered (see `_UNDELIVERABLE_REASON` in worker.py).

Why Playwright and not raw HTTP
-------------------------------
`channel_google_form.py` can POST directly because a Google Form has one
documented response endpoint and a machine-readable schema. An ATS has neither:
Ashby is a React/GraphQL app, Workable and SmartRecruiters render their form
client-side, and every vendor guards its POST with its own CSRF/token dance. The
part that decides it, though, is the resume: nearly every ATS form requires a
file upload, and reproducing nine vendors' multipart contracts by hand is a much
larger and more brittle surface than driving the form the way a person does.

Because there is no account, the browser here is deliberately *ephemeral* — no
persistent profile, no cookie reuse, launched and torn down per application.
That also sidesteps the profile-lock/asyncio cascade the board adapter has to
manage (see stealth.clear_stale_lock and the pw.stop() notes in internshala.py).

The discipline this module keeps
--------------------------------
It refuses rather than invents. A required question we cannot answer honestly,
a missing resume, a form we cannot read — each returns `needs_review` with the
reason, exactly like `channel_google_form.blocking_reason`. An application sent
under someone's real name with a made-up answer is worse than one not sent.
"""
from __future__ import annotations

import os
import random
import re

import questions
import resolver
import safety
import selector_ai
import stealth


def enabled() -> bool:
    """Fleet kill switch for this sender, independent of the auto-apply mode.

    Fail-closed like every other capability flag (GMAIL_SEND_ENABLED,
    GRINDLY_TIER_B_APPLY): a brand-new sender that files real applications under
    a user's name should be switchable off without a redeploy, and should never
    turn itself on because some other flag flipped.
    """
    return os.environ.get("GRINDLY_ATS_APPLY") == "1"


def _headless() -> bool:
    """Headed by default, like every other adapter in this fleet.

    The old default was headless, on the reasoning that no human ever needs to
    watch an ATS page — true, and beside the point. "Nobody is looking" is not
    the same question as "does the page believe this is a browser". Headless
    Chromium is trivially fingerprinted (navigator.webdriver, absent GPU
    renderer, missing permissions/plugins surfaces), and this is the sender
    MOST exposed to that check: an ATS portal is a public page reached with no
    session, no cookies and no history, from a datacenter IP.

    Dockerfile.worker already runs Chromium inside Xvfb precisely so the board
    adapters can be headed without a physical display (see INTERNPILOT_HEADLESS=0
    in docker-compose.yml). This sender was the one process in that container
    still opting out — paying for Xvfb and then handing every ATS page the one
    signal Xvfb exists to remove. A live run confirmed the cost: a Greenhouse
    application page answered with a human-check, which safety.detect_challenge
    correctly refused rather than tried to defeat.

    Set GRINDLY_ATS_HEADLESS=1 to force headless (local debugging, or a host
    with no display at all).
    """
    return os.environ.get("GRINDLY_ATS_HEADLESS", "0") != "0"


# Nav timeout is generous: ATS pages are client-rendered and the slow ones
# (Ashby, Workable) routinely take several seconds before the form exists.
_NAV_TIMEOUT_MS = int(os.environ.get("GRINDLY_ATS_NAV_TIMEOUT_MS", "45000"))

# The listing is gone. Worth distinguishing from a failure: a closed role should
# be skipped quietly, not retried or surfaced as something the user must fix.
_CLOSED_RE = re.compile(
    r"(no longer accepting|position (has been )?closed|job (is )?closed|"
    r"posting (is )?(closed|expired|no longer)|this role has been filled|"
    r"not accepting applications|404|page not found)",
    re.I,
)

# A cover-letter-shaped box gets the letter we already wrote for this role,
# rather than whatever generic paragraph the question engine would produce.
_COVER_RE = re.compile(
    r"(cover letter|why (should|do) (we|you)|why (this|our) (role|company|job)|"
    r"tell us about yourself|motivation|additional information|"
    r"anything else|introduce yourself)",
    re.I,
)

# Which file input is the resume, when a form offers more than one.
_RESUME_INPUT_RE = re.compile(r"(resume|cv|curriculum)", re.I)

# Reveals the form on vendors that keep it behind a button (Lever's "Apply for
# this job", Ashby's "Apply for this Job", SmartRecruiters' "I'm interested").
_APPLY_BUTTON_CANDIDATES = [
    "a:has-text('Apply for this job')",
    "button:has-text('Apply for this Job')",
    "a#apply_button",
    # Matched on the word alone, never on the apostrophe. SmartRecruiters
    # renders "I’m interested" with a typographic apostrophe (U+2019), so the
    # straight-quote selector matched nothing and a perfectly fillable form was
    # reported as "could not find the application form".
    "button:has-text('interested')",
    "a:has-text('interested')",
    "a:has-text('Apply now')",
    "button:has-text('Apply now')",
    "a:has-text('Apply')",
    "button:has-text('Apply')",
]

_SUBMIT_CANDIDATES = [
    "#submit_app",                                    # greenhouse
    "button[data-ui='submit-application']",           # workable
    "button:has-text('Submit application')",
    "button:has-text('Submit Application')",
    "button:has-text('Submit my application')",
    "input[type='submit']",
    "button[type='submit']",
    # Keka calls the submit button on its own application form "Apply Now" — it
    # is the ONLY button on that page, and looking for the word "submit" found
    # nothing, so every Keka application reported "could not find the submit
    # button" after filling the form perfectly.
    #
    # Safe to have last: this list is consulted only once the form has been
    # located and answered, so an "Apply" that merely opens a form has already
    # been clicked by `_APPLY_CANDIDATES` long before we get here.
    "button:has-text('Apply Now')",
    "button:has-text('Apply now')",
    "button:has-text('Submit')",
]

_SUCCESS_SELECTORS = [
    ":text('Thank you for applying')",
    ":text('Application submitted')",
    ":text('Your application has been submitted')",
    ":text('Thanks for applying')",
    ":text('successfully submitted')",
    ":text('We have received your application')",
    ":text('Thank you for your application')",
]

# What each vendor actually says, and where it goes, when a submit lands.
#
# The generic list above is a net for text; these are the vendor's own markup and
# its own post-submit URL. Both matter, because `safety.classify_submit` returns
# needs_review when it cannot confirm — and a needs_review on a submit that
# WORKED is the worst outcome in the system: the daily slot and the idempotency
# claim both stay spent (correctly — the click landed), the user is asked to go
# check an application that is already filed, and the run reports a success as an
# unknown. Every vendor here was read off its own confirmation page.
_VENDOR_SUCCESS: dict[str, list[str]] = {
    "greenhouse": [
        "#application_confirmation",
        ":text('Your application has been submitted')",
        ":text('Thank you for applying')",
    ],
    "lever": [
        ".application-confirmation",
        ":text('Thank you for applying')",
        ":text('Your application has been submitted')",
    ],
    "ashby": [
        "[data-testid='application-submitted']",
        ":text('Thanks for applying')",
        ":text('Application received')",
    ],
    "smartrecruiters": [
        "[data-test='application-success']",
        ":text('Thank you for applying')",
        ":text('Your application was sent')",
    ],
    "workable": [
        "[data-ui='application-success']",
        ":text('Thank you for applying')",
        ":text(\"We've received your application\")",
    ],
    "zoho": [":text('Thank you for applying')", ":text('successfully submitted')"],
    "freshteam": [":text('Thank you for applying')", ":text('Application submitted')"],
    "keka": [":text('Thank you for applying')", ":text('Application submitted')"],
    "darwinbox": [":text('Thank you')", ":text('Application submitted')"],
}

# A URL the vendor only ever navigates to AFTER a successful submit. Cheaper and
# harder to fake than text — Lever's /thanks is a different page, not a banner.
_VENDOR_SUCCESS_URLS: dict[str, tuple[str, ...]] = {
    "lever": ("/thanks", "/applied"),
    "greenhouse": ("confirmation", "/thanks"),
    "ashby": ("/application-submitted", "/confirmation"),
    "smartrecruiters": ("/confirmation", "thankyou", "thank-you"),
    "workable": ("/success", "/thanks"),
}


def vendor_success_selectors(vendor: str) -> list[str]:
    """Confirmation markup specific to one ATS vendor, or [] if we have none."""
    return list(_VENDOR_SUCCESS.get((vendor or "").lower(), []))


def _confirmed_by_url(page, vendor: str) -> bool:
    """Did the browser end up somewhere only a successful submit leads?

    The host has to match the vendor too. "/thanks" is Lever's confirmation path
    and also a substring of half the internet; reading it as a Workable success
    would report an application as delivered on the strength of someone else's
    thank-you page.
    """
    markers = _VENDOR_SUCCESS_URLS.get((vendor or "").lower())
    if not markers:
        return False
    try:
        current = (page.url or "").lower()
    except Exception:  # noqa: BLE001
        return False
    if (resolver.ats_vendor(current) or "") != (vendor or "").lower():
        return False
    return any(m in current for m in markers)

# Cookie/consent walls sit on top of the form on several EU-hosted ATS tenants.
_CONSENT_CANDIDATES = [
    "button:has-text('Accept all')",
    "button:has-text('Accept All')",
    "button:has-text('Accept')",
    "button:has-text('I agree')",
    "#onetrust-accept-btn-handler",
]


def _human_type(page, el, text: str) -> None:
    """Type at a human pace, into an EMPTY field.

    The clear is the whole point, and its absence was corrupting real
    applications. Several ATSs parse the uploaded resume and prefill name,
    email and phone — asynchronously, so the value lands AFTER read_fields has
    already decided the box was empty. `type()` then inserts at the cursor
    instead of replacing, and a live Keka form went out reading:

        First Name  'SammetaMahendhar'
        Phone       '8096267553809'
        Email       'mahendharsammeta2mahendharsammeta21@gmail.com1@gmail.com'

    The employer's own validation caught the email ("a part following '@'
    should not contain the symbol '@'") — which is what every "submit click
    registered but page shows a validation error" failure on an employer form
    actually was. Not a captcha: a mangled identity.

    internshala._human_type has always cleared first; this adapter never did.
    """
    try:
        stealth.scroll_to(page, el)
    except Exception:  # noqa: BLE001
        pass
    try:
        el.click()
    except Exception:  # noqa: BLE001
        pass
    # Select-all + Backspace rather than fill(""): fill() dispatches a single
    # input event that some React forms treat as a programmatic write and
    # revert, whereas a keyboard clear is indistinguishable from a person.
    try:
        el.press("Control+a")
        el.press("Backspace")
    except Exception:  # noqa: BLE001
        try:
            el.fill("")
        except Exception:  # noqa: BLE001
            pass
    el.type(text, delay=random.randint(18, 55))


def _pause(page, lo: int = 300, hi: int = 900) -> None:
    try:
        page.wait_for_timeout(random.randint(lo, hi))
    except Exception:  # noqa: BLE001
        pass


def _dismiss_consent(page) -> None:
    """Best-effort. A consent overlay intercepts clicks on the form beneath it,
    so this runs before anything is filled — but never blocks the apply if no
    banner is present, which is the common case."""
    for sel in _CONSENT_CANDIDATES:
        try:
            el = page.query_selector(sel)
            if el and el.is_visible():
                el.click(timeout=2000)
                _pause(page, 200, 500)
                return
        except Exception:  # noqa: BLE001
            continue


# A posting that has been taken down does not answer 404 on an ATS — it bounces
# to the company's board index. Greenhouse appends ?error=true; the tell that
# works across vendors is simpler: the address we landed on no longer mentions
# the posting we asked for.
#
# Worth its own branch because the fallback is so much worse. The board index
# lists every open role at the company, so the page is 50KB of real job text: it
# reads as a live posting, `_CLOSED_RE` finds nothing to match, and the sender
# then reports "could not find the application form" — sending the user to open
# a link that leads nowhere. Two of eight postings in a live probe were this.
# Lives in resolver so discovery can use the same test without importing this
# module (and Playwright with it) — a posting that is gone should be dropped
# before it is ever offered, not discovered at submit time.
_looks_gone = resolver.looks_gone
ats_vendor = resolver.ats_vendor


# Employers embed the ATS form in their own careers page inside an iframe. The
# form is perfectly fillable — it is just in another document, and every
# selector in this module (and in questions.read_fields) queries the top frame
# only. Rather than teach the whole stack about frames, go to the frame's own
# URL: it is a normal, standalone ATS application page.
#
# The iframe is identified by its HOST, never by a substring of its src. A
# `src*='greenhouse.io'` selector looked reasonable and was wrong in the worst
# way: Google's proxy iframe carries the parent origin in its query string
# ("content.googleapis.com/static/proxy.html?...origin=job-boards.greenhouse.io"),
# so it matched on every Greenhouse page, and the sender navigated off the real
# application form to a Google proxy. Nine of fourteen dry runs went from
# submit-ready to "could not find the form" the moment that shipped.
def _embedded_form_url(page) -> str:
    try:
        frames = page.query_selector_all("iframe")
    except Exception:  # noqa: BLE001
        return ""
    for el in frames or []:
        try:
            src = el.get_attribute("src") or ""
        except Exception:  # noqa: BLE001
            continue
        if src.startswith("http") and ats_vendor(src):
            return src
    return ""


# Where a vendor keeps the form when the posting page is only a description.
# Deterministic, and one navigation instead of hunting for a button whose label
# changes per tenant.
def _apply_url_for(url: str, vendor: str) -> str:
    base = (url or "").split("#", 1)[0].split("?", 1)[0].rstrip("/")
    suffix = {"lever": "/apply", "ashby": "/application", "workable": "/apply"}.get(
        (vendor or "").lower()
    )
    if not suffix or base.endswith(suffix):
        return ""
    return base + suffix


def _page_text(page) -> str:
    try:
        return (page.inner_text("body") or "")[:20000]
    except Exception:  # noqa: BLE001
        try:
            return (page.content() or "")[:20000]
        except Exception:  # noqa: BLE001
            return ""


def _file_inputs(page) -> list:
    try:
        return list(page.query_selector_all("input[type='file']"))
    except Exception:  # noqa: BLE001
        return []


def _attach_resume(page, inputs: list, resume_path: str) -> bool:
    """Upload the resume to the likeliest input. Returns True on success.

    `set_input_files` is used on the element handle directly because ATS forms
    almost always hide the real <input type=file> behind a styled button — a
    visible-element click would open the OS file picker, which is not something
    a server can answer.
    """
    ranked = sorted(
        inputs,
        key=lambda el: 0 if _RESUME_INPUT_RE.search(
            " ".join(filter(None, [
                el.get_attribute("name") or "",
                el.get_attribute("id") or "",
                el.get_attribute("aria-label") or "",
            ]))
        ) else 1,
    )
    for el in ranked:
        try:
            el.set_input_files(resume_path)
            _pause(page, 700, 1600)   # let the vendor's async upload settle
            return True
        except Exception as e:  # noqa: BLE001
            print(f"[ats] resume upload failed on one input: {e}")
            continue
    return False


def _reveal_form(page) -> None:
    """Some vendors keep the form behind an Apply button. Click it once if the
    page shows no answerable fields yet — once, because a second click on an
    already-open form is as likely to hit a submit as to help."""
    try:
        if page.query_selector("input[type='file'], textarea"):
            return
    except Exception:  # noqa: BLE001
        return
    btn = selector_ai.find_element(page, "apply / open application form button",
                                   _APPLY_BUTTON_CANDIDATES)
    if not btn:
        return
    try:
        stealth.human_click(page, btn)
    except Exception:  # noqa: BLE001
        return
    try:
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:  # noqa: BLE001
        pass
    _pause(page, 600, 1400)


def open_the_form(page, url: str) -> list:
    """Get from wherever we landed to the page that actually holds the form.

    Three ways a posting hides its form, tried cheapest first:

      1. it is already here (Greenhouse renders the form under the description)
      2. it is embedded from the ATS in an iframe on the employer's own page
      3. it lives at the vendor's own /apply or /application address

    Returns the file inputs found — empty means no form was reachable. Shared
    with apply_probe so the probe measures the path the sender actually walks.
    """
    embed = _embedded_form_url(page)
    if embed:
        try:
            page.goto(embed, timeout=_NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:  # noqa: BLE001
            pass          # the wrapper page is still there to try

    _reveal_form(page)
    uploads = _file_inputs(page)
    if uploads:
        return uploads

    # Don't go hunting for the apply page of a posting that is gone. Ashby
    # client-routes a removed posting to the board index; navigating to
    # <posting>/application from there puts the posting id back in the address
    # bar and erases the only evidence that it was ever taken down — so the
    # caller reports "could not find the form" for a job that no longer exists.
    try:
        if _looks_gone(url, page.url or ""):
            return []
    except Exception:  # noqa: BLE001
        pass

    direct = _apply_url_for(url, ats_vendor(url) or "")
    if not direct:
        return []
    try:
        page.goto(direct, timeout=_NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        page.wait_for_load_state("networkidle", timeout=15000)
    except Exception:  # noqa: BLE001
        return []
    _dismiss_consent(page)
    _reveal_form(page)
    return _file_inputs(page)


def _apply_cover_letter(fields: list[dict], answers: list[dict], cover_letter: str) -> None:
    """Put the tailored letter in the cover-letter box, replacing whatever the
    question engine generated for it."""
    if not cover_letter:
        return
    for rec in answers:
        f = fields[rec["_i"]]
        if f["kind"] == "textarea" and _COVER_RE.search(f["label"] or ""):
            rec["answer"] = cover_letter[:4000]
            rec["source"] = "cover_letter"
            return


def _unanswered_required(fields: list[dict], answers: list[dict]) -> list[str]:
    """Required questions still blank after answering — the refuse-don't-invent
    check. Mirrors channel_google_form.blocking_reason."""
    answered = {r["_i"] for r in answers if (r.get("answer") or "").strip()}
    return [
        (f["label"] or "(unlabelled)")[:60]
        for i, f in enumerate(fields)
        if f.get("required") and i not in answered
    ]


# The stored facts, in the words setup uses for them. A refusal that says
# "could not answer: Graduation Month & Year (Completed / Expected) *" quotes
# the employer's form at a user who has never seen it; the same refusal saying
# "your graduation month" points at the box they can go and fill, once, for
# every future application.
#
# The key on the right is the SETUP question's own key (src/lib/proffQuestions),
# so the dashboard can take the user to the exact box instead of to a page of
# thirty. Stored on the application row as `blocking_facts`.
_FACT_LABELS = {
    "grad_month": "your graduation month",
    "grad_year": "your graduation year",
    "date_of_birth": "your date of birth",
    "expected_stipend": "the stipend you expect",
    "current_salary": "whether you're earning right now",
    "years_experience": "your years of work experience",
    "education_start_year": "the year you started your degree",
    "previous_internship": "whether you've interned before",
    "portfolio_url": "your portfolio or GitHub link",
    "linkedin_url": "your LinkedIn link",
    "github_url": "your GitHub link",
    "notice_period": "your notice period",
    "current_location": "the city you're in",
    "preferred_locations": "where you want to work",
    "gender": "your gender",
    "nationality": "your nationality",
    "country": "the country you're in",
    "differently_abled": "the disability question",
    "college": "your college name",
    "degree": "your degree",
    "class10_percent": "your class 10 percentage",
    "class12_percent": "your class 12 percentage",
    "hours_per_week": "the hours a week you can commit",
    "availability": "when you can start",
    "willing_to_relocate": "whether you'd relocate",
    "work_authorization": "your work authorization",
    "gpa": "your CGPA",
    "phone": "your phone number",
}


# The same facts, keyed the way SETUP names them, so the dashboard can point at
# one box. Only the ones a real application has been measured to stop on need an
# entry; anything absent falls back to the profile column name, which is still a
# truthful thing to say and simply does not deep-link.
_SETUP_KEYS = {
    "grad_month": "gradMonth",
    "grad_year": "gradYear",
    "date_of_birth": "dateOfBirth",
    "expected_stipend": "expectedStipend",
    "current_salary": "currentSalary",
    "years_experience": "yearsExperience",
    "education_start_year": "educationStartYear",
    "previous_internship": "previousInternship",
    "portfolio_url": "portfolioUrl",
    "linkedin_url": "linkedinUrl",
    "github_url": "githubUrl",
    "notice_period": "noticePeriod",
    "current_location": "currentLocation",
    "preferred_locations": "preferredLocations",
    "gender": "gender",
    "nationality": "nationality",
    "country": "country",
    "differently_abled": "differentlyAbled",
    "college": "college",
    "degree": "degree",
    "class10_percent": "class10Percent",
    "class12_percent": "class12Percent",
    "hours_per_week": "hoursPerWeek",
    "availability": "availability",
    "willing_to_relocate": "willingToRelocate",
    "work_authorization": "workAuthorization",
    "gpa": "gpa",
    "phone": "phone",
}


def blocking_fact_keys(labels: list[str], profile: dict) -> list[str]:
    """Which stored facts these unanswered questions were waiting on, in setup's
    own keys. Order-stable and de-duplicated; [] when none of them is a fact
    setup collects."""
    out: list[str] = []
    for label in labels:
        key = questions.missing_fact_for(label, profile)
        if not key:
            continue
        setup_key = _SETUP_KEYS.get(key, key)
        if setup_key not in out:
            out.append(setup_key)
    return out


def _blocking_facts(labels: list[str], profile: dict) -> list[str]:
    """Which of these unanswered questions setup could have answered, named as
    the thing the user would go and fill.

    Splitting them out is the whole point. "The agent could not answer a
    required question" reads as a broken agent; it is two different situations
    with opposite fixes, and only one of them is ours (see
    questions.missing_fact_for).
    """
    out: list[str] = []
    for label in labels:
        key = questions.missing_fact_for(label, profile)
        if not key:
            continue
        said = _FACT_LABELS.get(key, key.replace("_", " "))
        if said not in out:
            out.append(said)
    return out


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
    """Submit an application on an employer's ATS portal.

    Same (status, reason) contract as every other channel and platform adapter,
    so the worker treats it identically.

    status ∈ {applied, skipped, failed, needs_review}
    """
    profile = profile or {}
    record = record if record is not None else {}
    url = target or job.get("url") or ""
    if not url:
        return "skipped", "no ATS URL resolved"
    if not enabled():
        return "needs_review", "ATS auto-apply is switched off — open it yourself to send it"
    if not resume_path or not os.path.exists(resume_path):
        # Not a failure of this listing — it is a gap in the user's profile, and
        # it would recur on every ATS application until they fix it.
        return "needs_review", "no resume file available to upload — add one in your profile"

    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    browser = None
    # Once the submit click lands, nothing below may be reported as a plain
    # "failed". worker._dispatch_apply retries selector/element-shaped failures,
    # and a retry after a click that already went through files a SECOND real
    # application under the candidate's name — the one error in this module that
    # a user cannot undo.
    submitted = False
    try:
        try:
            browser = pw.chromium.launch(
                headless=_headless(),
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as e:  # noqa: BLE001
            return "failed", f"could not start a browser: {str(e)[:120]}"

        ctx = browser.new_context(
            user_agent=stealth.random_ua(),
            viewport=stealth.random_viewport(),
            accept_downloads=False,
        )
        stealth.apply_stealth(ctx)
        # Before the first navigation, so nothing heavy is in flight already.
        # One vCPU shared with everything else on the box; decoding a careers
        # page's hero imagery and icon font is pure cost to a form-filler.
        stealth.block_heavy_resources(ctx)
        page = ctx.new_page()

        try:
            page.goto(url, timeout=_NAV_TIMEOUT_MS, wait_until="domcontentloaded")
        except Exception as e:  # noqa: BLE001
            return "failed", f"could not open the application page: {str(e)[:120]}"

        try:
            page.wait_for_load_state("networkidle", timeout=15000)
        except Exception:  # noqa: BLE001
            pass          # client-rendered pages often never go fully idle

        _dismiss_consent(page)

        try:
            landed = page.url or ""
        except Exception:  # noqa: BLE001
            landed = ""
        if _looks_gone(url, landed):
            return "skipped", "listing is closed — the posting is no longer on the employer's board"

        body = _page_text(page)
        if _CLOSED_RE.search(body[:4000]):
            return "skipped", "listing is closed — the ATS is no longer accepting applications"

        if safety.detect_challenge(page) == safety.FAILURE_REASON.CAPTCHA:
            return "needs_review", "the application page shows a human-check — open it yourself"

        uploads = open_the_form(page, url)
        # Ashby and friends are single-page apps: a removed posting is fetched,
        # 404s, and only THEN client-side-routes to the board index — after
        # networkidle, so the check above the fold ran while the URL was still
        # the one we asked for. Re-asking here is what turns "we could not find
        # the form" into the true answer, which is "this posting is gone".
        try:
            landed = page.url or ""
        except Exception:  # noqa: BLE001
            landed = ""
        if not uploads and _looks_gone(url, landed):
            return "skipped", "listing is closed — the posting is no longer on the employer's board"
        if not uploads:
            return "needs_review", "could not find the application form — open it yourself to send it"
        if not _attach_resume(page, uploads, resume_path):
            return "needs_review", "the form would not accept the resume upload — open it yourself"

        # Read the form only AFTER the upload: several vendors parse the resume
        # and prefill name/email/phone from it, and read_fields deliberately
        # skips already-filled inputs so we do not clobber that.
        fields = questions.read_fields(page)
        answers: list[dict] = []
        if fields:
            answers = questions.answer_fields(
                fields,
                profile=profile,
                resume_text=profile.get("resume_text") or "",
                skills=skills or profile.get("skills") or [],
                job=job,
                name=profile.get("name") or "",
                email=profile.get("email") or "",
            )
            _apply_cover_letter(fields, answers, cover_letter)

            missing = _unanswered_required(fields, answers)
            if missing:
                record["answers"] = questions.to_record(answers)
                # Say whose problem it is. A live run refused three real
                # employer forms in a row on "Date of Birth *", "Expected
                # Salary *" and "Graduation Month & Year *" — every one a fact
                # only the user can state, every one a box they had never been
                # shown, and the reason on their dashboard quoted the
                # employer's asterisks back at them. One sentence naming the
                # setup field turns three stalled applications into one edit.
                gaps = _blocking_facts(missing, profile)
                # The same answer in the form the product can act on: the
                # dashboard reads this to say "two applications are waiting on
                # your date of birth" and take them to that box.
                record["blocking_facts"] = blocking_fact_keys(missing, profile)
                if gaps:
                    return "needs_review", (
                        "waiting on facts only you can give: "
                        + ", ".join(gaps[:3])
                        + " — add them once in Setup and this sends itself"
                    )
                return "needs_review", (
                    "could not answer required question(s): " + "; ".join(missing[:3])
                )

            filled = questions.fill(page, fields, answers, _human_type)
            record["answers"] = questions.to_record(answers)
            if filled:
                print(f"[ats] answered {filled} question(s)")
            _pause(page, 500, 1200)

        submit = selector_ai.find_element(page, "submit application button", _SUBMIT_CANDIDATES)
        if not submit:
            safety.screenshot(page, uid, f"ats_no_submit_{job.get('external_id', '')}")
            return "needs_review", "could not find the submit button — open it yourself to send it"

        record["destination"] = url

        # Ask the form whether it will take this BEFORE spending the click.
        #
        # Five real applications were clicked through and rejected with "page
        # shows a validation/error message" — each one burning a daily slot and
        # an idempotency claim on a submit that never had a chance. The check
        # above (`_unanswered_required`) tests the answers we meant to write;
        # this tests what the form is actually holding, which is a different
        # thing every time `fill` gives up on a control. A react-select whose
        # option never matched leaves the box empty and returns quietly, and
        # that empty box is what the vendor refused.
        #
        # Refusing here returns needs_review WITHOUT `submit_attempted`, so the
        # worker refunds the slot and leaves the row re-scorable: nothing
        # reached the employer.
        blocked = questions.form_blockers(page, submit)
        if fields:
            blocked += [
                f"{lab} — still empty"
                for lab in questions.unfilled_required(fields)
                if not any(lab[:40] in b for b in blocked)
            ]
        if blocked:
            safety.screenshot(page, uid, f"ats_blocked_{job.get('external_id', '')}")
            # A blocker the USER could clear must be asked for, not just
            # reported. These come from the browser's own validation, which
            # names the control ("Gender * — Please select an item in the
            # list."), and several of those names are facts setup already knows
            # how to collect. Without this the row said only "the form will not
            # accept it yet" and nothing ever prompted for the missing answer —
            # so a single blank field blocked that employer's form, and every
            # other form asking the same thing, permanently.
            labels = [b.split(" — ")[0].strip() for b in blocked]
            record["blocking_facts"] = blocking_fact_keys(labels, profile)
            gaps = _blocking_facts(labels, profile)
            if gaps:
                return "needs_review", (
                    "waiting on facts only you can give: " + ", ".join(gaps[:3])
                    + " — add them once in Setup and this sends itself"
                )
            return "needs_review", (
                "the form will not accept it yet: " + "; ".join(blocked[:3])
            )

        # A human check we cannot answer, and must not try to.
        #
        # This is the measured reason employer-hosted applications were failing
        # while every readiness check said "submit-ready": the form fills fine,
        # then Cloudflare asks for a tick. Botsync's Workable page was clicked
        # into an unticked "Verify you are human" box, sat on "Submitting…"
        # forever, and burned a real daily slot for an application no employer
        # ever saw.
        #
        # Returning BEFORE `submit_attempted` is what makes this worth doing:
        # the worker refunds the slot and the idempotency claim, and hands the
        # listing to the user's own browser — which has a person to tick the
        # box and a residential IP. Solving it here is not on the table.
        human_check = questions.unsolved_captcha(page)
        if human_check:
            safety.screenshot(page, uid, f"ats_captcha_{job.get('external_id', '')}")
            return "needs_review", (
                f"this employer asks for a {human_check} before submitting — "
                "sending it to your own browser, where you can tick it"
            )

        # Point of no return. The worker refunds the daily slot and the
        # idempotency claim for a needs_review WITHOUT this flag (nothing was
        # sent); WITH it, both stay spent — the click may have landed.
        record["submit_attempted"] = True
        try:
            stealth.human_click(page, submit)
        except Exception as e:  # noqa: BLE001
            return "failed", f"could not click submit: {str(e)[:120]}"
        submitted = True

        # One wait, then classify. Never re-click and never retry from here: the
        # click may well have gone through, and a second submit files a real
        # duplicate application under the candidate's name.
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:  # noqa: BLE001
            pass
        _pause(page, 1500, 3000)

        vendor = resolver.ats_vendor(url) or ""
        status, why = safety.classify_submit(
            page, vendor_success_selectors(vendor) + _SUCCESS_SELECTORS
        )
        # A vendor that answers a successful submit by NAVIGATING says so in the
        # URL bar even when its confirmation text is inside a shadow root or an
        # iframe we cannot query. Only ever upgrades an unconfirmed result — an
        # explicit validation error on the page still wins.
        if status == safety.APPLY_STATUS.NEEDS_REVIEW and _confirmed_by_url(page, vendor):
            status, why = safety.APPLY_STATUS.APPLIED, f"submitted — {vendor} confirmation page"

        # A rejection is the one outcome worth a picture. Six real applications
        # were refused by a form and every one of them had to be diagnosed by
        # re-enacting the whole submit live, because all we kept was our own
        # sentence about it. The page said which field it was unhappy about, on
        # screen, and nobody was looking.
        if status == safety.APPLY_STATUS.FAILED:
            try:
                shot = safety.screenshot(
                    page, uid, f"ats_rejected_{job.get('external_id', '')}"
                )
                if shot:
                    record["screenshot_path"] = shot
            except Exception:  # noqa: BLE001
                pass

        # Proof for the states the user most needs it for: the success they are
        # being asked to believe, and the ambiguous one they may have to check.
        if status in (safety.APPLY_STATUS.APPLIED, safety.APPLY_STATUS.NEEDS_REVIEW):
            shot = safety.screenshot(page, uid, f"ats_{job.get('external_id', '')}")
            if shot:
                record["screenshot_path"] = shot

        if status == safety.APPLY_STATUS.APPLIED:
            return "applied", "submitted on the company's own application portal"
        return status, why
    except Exception as e:  # noqa: BLE001
        if submitted:
            return "needs_review", (
                "the application was submitted but the page could not be read "
                f"afterwards — check before re-sending ({str(e)[:100]})"
            )
        return "failed", f"ATS application error: {str(e)[:160]}"
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        # Stop the driver too. close() alone leaves the sync_playwright node
        # process alive, and this runs inside the long-lived --serve worker where
        # those accumulate until it dies. Same fix as the board adapters carry.
        try:
            pw.stop()
        except Exception:  # noqa: BLE001
            pass
