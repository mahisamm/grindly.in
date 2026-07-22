"""Live Internshala driver (Playwright, headed, persistent profile).

Two jobs:
  fetch()  -> scrape public listing cards into the same dict shape as mockboard.
  apply()  -> best-effort: open the detail page and submit the apply form.
              Internshala requires a logged-in account; the persistent profile
              (browser_profile/) means the user logs in ONCE and the agent
              reuses the session. If not logged in, apply() returns 'login_required'.

Human-behaviour layer:
  All interactions use _human_type() and _human_click() so timing looks organic
  and bot-detection heuristics on Internshala's side are not triggered.
  Character-level typing (30-350 ms per key), randomised pauses between actions,
  scroll-before-click, and a "reading pause" after page load are all included.
"""
from __future__ import annotations
import json
import os
import random
import re
import urllib.parse

import questions
import safety
import selector_ai
import stealth


def _jlist(v) -> list[str]:
    if not v:
        return []
    try:
        return json.loads(v) if isinstance(v, str) else list(v)
    except Exception:  # noqa: BLE001
        return []

BASE = "https://internshala.com"


def _profile_base() -> str:
    """Root dir holding per-user persistent browser profiles.

    Must live on a volume SHARED between the web app (which kicks off connect)
    and every worker replica that applies — otherwise a session saved by one
    container is invisible to the next. Defaults to <root>/data/browser_profile
    (the appdata volume in docker-compose); override with GRINDLY_PROFILE_BASE.
    """
    env = os.environ.get("GRINDLY_PROFILE_BASE")
    if env:
        return env
    return os.path.join(os.path.dirname(__file__), "..", "data", "browser_profile")


PROFILE_DIR = os.path.join(_profile_base(), "shared", "internshala")

_contexts: dict = {}


def _profile_dir(uid: str) -> str:
    if not uid:
        return PROFILE_DIR
    return os.path.join(_profile_base(), uid, "internshala")


def _context(uid: str = ""):
    key = uid or "shared"
    if key in _contexts:
        return _contexts[key][1]
    from playwright.sync_api import sync_playwright
    profile = _profile_dir(uid)
    os.makedirs(profile, exist_ok=True)
    stealth.clear_stale_lock(profile)
    pw = sync_playwright().start()
    try:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=os.environ.get("INTERNPILOT_HEADLESS", "0") == "1",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--no-first-run",
                "--disable-dev-shm-usage",
            ],
            viewport=stealth.random_viewport(),
            user_agent=stealth.random_ua(),
        )
        stealth.apply_stealth(ctx)
    except Exception:
        # Stop the just-started driver instead of leaking it; a leaked pw poisons
        # this thread's asyncio loop for the next sync_playwright().start().
        try:
            pw.stop()
        except Exception:
            pass
        raise
    _contexts[key] = (pw, ctx)
    return ctx


def close(uid: str = ""):
    key = uid or "shared"
    entry = _contexts.pop(key, None)
    if entry:
        pw, ctx = entry
        try:
            ctx.close()
        except Exception:
            pass
        # Stop the driver too — ctx.close() alone leaves the sync_playwright node
        # process running, which accumulates over the long-lived --serve worker.
        try:
            pw.stop()
        except Exception:
            pass


# ── human-behaviour helpers ───────────────────────────────────────

def _human_type(page, element, text: str, wpm: int = 62) -> None:
    """Type text character by character at human speed (~60 wpm with variation).

    Internshala's session recorder logs keystroke intervals — instant fill()
    is a bot signal. This function generates organic keystroke timing.
    """
    if not text:
        return
    try:
        element.scroll_into_view_if_needed()
        page.wait_for_timeout(random.randint(150, 400))
        element.click()
        page.wait_for_timeout(random.randint(200, 500))
        try:
            element.triple_click()
            page.wait_for_timeout(100)
        except Exception:
            pass

        ms_per_char = 60_000 / (wpm * 5)  # avg keystroke gap in ms

        for i, ch in enumerate(text):
            delay = int(random.gauss(ms_per_char, ms_per_char * 0.38))
            delay = max(28, min(delay, 380))
            page.keyboard.type(ch)
            page.wait_for_timeout(delay)

            # Pause slightly longer after sentence-ending punctuation
            if ch in ".!?" and i < len(text) - 1 and text[i + 1] == " ":
                page.wait_for_timeout(random.randint(220, 680))
            # Pause after newlines (paragraph break = reading moment)
            elif ch == "\n":
                page.wait_for_timeout(random.randint(280, 580))

    except Exception as e:
        print(f"[internshala] human_type fallback: {e}")
        try:
            element.fill(text)
        except Exception:
            pass


def _human_click(page, element) -> None:
    """Scroll element into view, hover briefly, then click."""
    try:
        element.scroll_into_view_if_needed()
        page.wait_for_timeout(random.randint(180, 500))
        element.hover()
        page.wait_for_timeout(random.randint(80, 260))
        element.click()
    except Exception:
        try:
            element.click()
        except Exception:
            pass


def _read_pause(page, min_ms: int = 1200, max_ms: int = 3200) -> None:
    """Simulate reading the page — random pause so timing looks organic."""
    page.wait_for_timeout(random.randint(min_ms, max_ms))


def _scroll_down(page, px: int = 300) -> None:
    """Scroll down slightly to simulate a human skimming the page."""
    try:
        page.evaluate(f"window.scrollBy(0, {px + random.randint(-80, 80)})")
        page.wait_for_timeout(random.randint(300, 700))
    except Exception:
        pass


# ── search / fetch ────────────────────────────────────────────────

def _search_url(domains: list[str]) -> str:
    if domains:
        kw = urllib.parse.quote(domains[0].strip().lower().replace(" ", "-"))
        return f"{BASE}/internships/keywords-{kw}"
    return f"{BASE}/internships"


def _search_url_paged(domains: list[str], page_num: int = 1) -> str:
    base = _search_url(domains)
    return base if page_num <= 1 else f"{base}?page_number={page_num}"


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    seen_ids: set[str] = set()
    try:
        for pnum in range(1, 4):  # pages 1-3
            if len(jobs) >= limit:
                break
            page.goto(_search_url_paged(domains, pnum), wait_until="domcontentloaded", timeout=45000)
            _read_pause(page, 1500, 3000) if pnum == 1 else _read_pause(page, 800, 2000)
            _scroll_down(page, 400)

            cards = page.query_selector_all(".individual_internship")
            new_this_page = 0
            for c in cards:
                if len(jobs) >= limit:
                    break
                try:
                    title    = _text(c, [".job-internship-name", ".profile", "h3"])
                    company  = _text(c, [".company-name", ".company_name", "p.company-name"])
                    location = _text(c, [".locations", ".location_link", ".row-1-item.locations"])
                    stipend  = _text(c, [".stipend", ".desktop-stipend"])
                    duration = _text(c, [".ic-16-calendar + span", ".item_body"])
                    href     = c.get_attribute("data-href") or _attr(c, ["a.job-title-href", "a"], "href")
                    jid      = c.get_attribute("internshipid") or (href or str(len(jobs)))
                    if not title or not href:
                        continue
                    if str(jid) in seen_ids:
                        continue
                    seen_ids.add(str(jid))
                    url = href if href.startswith("http") else BASE + href
                    jobs.append({
                        "source":      "internshala",
                        "external_id": str(jid),
                        "title":       title,
                        "company":     company or "Unknown",
                        "location":    location or "",
                        "stipend":     stipend or "",
                        "duration":    duration or "",
                        "skills":      _infer_skills(title),
                        "url":         url,
                    })
                    new_this_page += 1
                except Exception:
                    continue
            if new_this_page == 0:
                break
    finally:
        page.close()
    return jobs


def scrape_jd(url: str, uid: str = "") -> str:
    """Extract job description text from a listing page. Returns '' on failure."""
    page = _context(uid).new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=25000)
        _read_pause(page, 600, 1400)
        return _text(page, [
            "#internship_details",
            ".internship-details-section",
            "[class*='about-internship']",
            ".about-internship",
            ".details-container",
            "[class*='description']",
        ])[:1500]
    except Exception:
        return ""
    finally:
        try:
            page.close()
        except Exception:
            pass


def harvest_questions(url: str, uid: str = "") -> list[dict]:
    """Read-only: open the listing, click through to the apply form, and return
    its screening questions — WITHOUT filling or submitting anything. Lets the
    Apply Kit draft truthful answers before the user ever opens the form
    themselves.

    Internshala hides its per-listing questions behind the "Apply now" click (a
    multi-step flow) — a bare page load, like scrape_jd() does, isn't enough to
    see them. Clicking that button only navigates to the application form itself;
    it is the same action a human browsing this listing would take next, and
    nothing is typed or submitted here. Mirrors apply()'s first few steps exactly,
    then stops well before the resume upload / cover letter / submit steps.
    """
    page = _context(uid).new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=25000)
        _read_pause(page, 1000, 2000)

        if safety.detect_challenge(page) or _is_logged_out(page):
            return []

        _scroll_down(page, random.randint(250, 500))
        btn = selector_ai.find_element(page, "apply now button or continue button", [
            "#continue_button",
            "#apply_now_button",
            "button:has-text('Apply now')",
            "a:has-text('Apply now')",
        ])
        if not btn:
            return []

        _human_click(page, btn)
        _read_pause(page, 800, 1600)
        if safety.detect_challenge(page):
            return []

        return questions.read_fields(page)
    except Exception as e:  # noqa: BLE001
        print(f"[internshala] harvest_questions error: {e}")
        return []
    finally:
        try:
            page.close()
        except Exception:
            pass


# ── apply ─────────────────────────────────────────────────────────

def apply(
    job: dict,
    cover_letter: str,
    uid: str = "",
    profile: dict | None = None,
    resume_path: str | None = None,
    record: dict | None = None,
) -> tuple[str, str]:
    """Submit an application. Returns (status, reason).

    status ∈ {applied, login_required, skipped, failed, needs_review}

    `record` is an optional out-parameter the caller can pass to collect side
    evidence about the attempt — currently the screening-question Q&A and the
    proof screenshot. It exists so the user can be shown exactly what was
    submitted in their name without changing this function's return shape (all
    five platform adapters share it).

    Reliability layers:
    - CSS selector list tried first; AI fallback (LLM) used if all fail.
    - Captcha detected and surfaced as distinct failure reason.
    - Screenshot saved on any non-trivial failure, AND on success (proof).
    - Timeout retried once before giving up.
    """
    manual_final_submit, hold_reason = safety.requires_manual_final_submit("internshala")
    if manual_final_submit:
        return "needs_review", hold_reason
    page = _context(uid).new_page()
    try:
        try:
            page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            if "timeout" in str(e).lower():
                # retry once on timeout — transient network blip
                print(f"[internshala] timeout on first load, retrying: {e}")
                try:
                    page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
                except Exception as e2:
                    safety.screenshot(page, uid, f"timeout_{job.get('external_id','')}")
                    return "failed", f"timeout after retry: {str(e2)[:100]}"
            else:
                raise

        _read_pause(page, 1500, 3500)

        # Check for captcha before doing anything else
        captcha_reason = safety.detect_challenge(page)
        if captcha_reason:
            safety.screenshot(page, uid, f"captcha_{job.get('external_id','')}")
            return "failed", "captcha challenge detected — cannot proceed headlessly"

        if _is_logged_out(page):
            return "login_required", "not signed in to Internshala (log in once in the agent browser)"

        _scroll_down(page, random.randint(250, 500))
        _read_pause(page, 800, 1800)

        # Apply button — try CSS selectors, then AI
        btn = selector_ai.find_element(page, "apply now button or continue button", [
            "#continue_button",
            "#apply_now_button",
            "button:has-text('Apply now')",
            "a:has-text('Apply now')",
        ])
        if not btn:
            if (page.query_selector(":text('Application sent')")
                    or page.query_selector(":text('Already applied')")):
                return "skipped", "already applied"
            # A listing can close between the day we banked it and the day it comes
            # due — a match scheduled three weeks out routinely will have. That is
            # not a broken selector and it is not our failure; report it as what it
            # is, so the worker pulls a fresh match forward instead of counting a
            # dead posting against the day's batch.
            if _listing_closed(page):
                return "skipped", "listing closed — no longer accepting applications"
            safety.screenshot(page, uid, f"no_apply_btn_{job.get('external_id','')}")
            return "skipped", "unsupported Internshala application flow (no direct apply button)"

        _human_click(page, btn)
        _read_pause(page, 1000, 2200)

        # Check for captcha after clicking apply (sometimes deferred)
        captcha_reason = safety.detect_challenge(page)
        if captcha_reason:
            safety.screenshot(page, uid, f"captcha_post_click_{job.get('external_id','')}")
            return "failed", "captcha after apply click"

        # Upload tailored resume if available (PDF)
        if resume_path and os.path.isfile(resume_path):
            file_inp = _attr_el(page, [
                "input[type='file'][accept*='pdf']",
                "input[type='file']",
            ])
            if file_inp:
                try:
                    file_inp.set_input_files(resume_path)
                    page.wait_for_timeout(random.randint(700, 1400))
                except Exception as e:
                    print(f"[internshala] resume upload failed: {e}")

        # Cover letter — AI fallback if default selectors miss it
        cl = selector_ai.find_element(page, "cover letter textarea or rich text editor", [
            "#cover_letter_box",
            "textarea[name='cover_letter']",
            "div[contenteditable='true']",
        ])
        if cl:
            _human_type(page, cl, cover_letter[:1500])
            _read_pause(page, 400, 900)

        # Screening questions.
        #
        # This is the make-or-break step on Internshala: most listings gate the
        # submit behind per-listing questions, and a wrong answer is worse than a
        # failed apply — it goes out under the candidate's name and they never see
        # it. So: read the actual question text, answer facts from the profile and
        # everything else from the resume, and hand the full Q&A back to the caller
        # so it lands on the application row.
        #
        # What was here before typed one identical canned sentence into every
        # textarea regardless of the question, "Yes" into every required text
        # input, and a hardcoded "8.5" CGPA over the user's real one.
        answered = 0
        try:
            fields = questions.read_fields(page)
            if fields:
                answers = questions.answer_fields(
                    fields,
                    profile=profile or {},
                    resume_text=(profile or {}).get("resume_text") or "",
                    skills=_jlist((profile or {}).get("skills")),
                    job=job,
                    name=(profile or {}).get("name") or "",
                    email=(profile or {}).get("email") or "",
                )
                answered = questions.fill(page, fields, answers, _human_type)
                if record is not None:
                    record["answers"] = questions.to_record(answers)
                if answered:
                    print(f"[internshala] answered {answered} screening question(s)")
                _read_pause(page, 400, 900)
        except Exception as e:  # noqa: BLE001
            # A form we couldn't read is not a reason to abandon the application —
            # the submit below may still succeed if nothing was actually required.
            print(f"[internshala] screening questions could not be answered: {e}")

        _read_pause(page, 600, 1400)

        # Submit button — AI fallback
        submit = selector_ai.find_element(page, "submit application button", [
            "#submit",
            "button:has-text('Submit application')",
            "input[type='submit']",
            "button[type='submit']",
        ])
        if not submit:
            safety.screenshot(page, uid, f"no_submit_btn_{job.get('external_id','')}")
            return "skipped", "complex Internshala application requires manual completion"

        _human_click(page, submit)
        page.wait_for_timeout(random.randint(2000, 3500))

        status, why = safety.classify_submit(page, [
            ":text('Application sent')", ":text('successfully')", ":text('Thank you')",
        ])

        # Proof. "Applied" was previously a claim with nothing behind it: screenshots
        # were captured on every failure path and none on success, so the one state
        # the user most needs evidence for was the one state with no evidence. Also
        # capture needs_review — that's the ambiguous case, and it's precisely what a
        # human has to look at to resolve.
        if status in (safety.APPLY_STATUS.APPLIED, safety.APPLY_STATUS.NEEDS_REVIEW):
            shot = safety.screenshot(page, uid, f"{status}_{job.get('external_id', '')}")
            if shot and record is not None:
                record["screenshot_path"] = shot

        return status, why

    except Exception as e:
        err = str(e)
        try:
            safety.screenshot(page, uid, f"exception_{job.get('external_id','')}")
        except Exception:
            pass
        return "failed", f"error: {err[:120]}"
    finally:
        page.close()


# ── helpers ───────────────────────────────────────────────────────

# Phrasings Internshala uses when a posting is no longer live. Matched against the
# page text, not a selector, because the markup differs between "expired",
# "closed by the employer", and "hiring complete" but the wording does not.
_CLOSED = re.compile(
    r"no longer accepting|applications? (are )?closed|this internship is closed|"
    r"hiring (is )?(now )?closed|expired|position (has been )?filled|"
    r"not accepting applications",
    re.I,
)


def _listing_closed(page) -> bool:
    try:
        return bool(_CLOSED.search(page.inner_text("body") or ""))
    except Exception:  # noqa: BLE001
        return False


def _is_logged_out(page) -> bool:
    html = page.content().lower()
    return (
        ("login" in html and "register" in html and "logout" not in html)
        or bool(page.query_selector("a[href*='login']:visible"))
    )


def _text(scope, selectors):
    for s in selectors:
        el = scope.query_selector(s)
        if el:
            t = (el.inner_text() or "").strip()
            if t:
                return re.sub(r"\s+", " ", t)
    return ""


def _attr(scope, selectors, attr):
    for s in selectors:
        el = scope.query_selector(s)
        if el:
            v = el.get_attribute(attr)
            if v:
                return v
    return None


def _first(page, selectors):
    for s in selectors:
        try:
            el = page.query_selector(s)
            if el:
                return el
        except Exception:
            continue
    return None


def _attr_el(scope, selectors):
    for s in selectors:
        try:
            el = scope.query_selector(s)
            if el:
                return el
        except Exception:
            continue
    return None


_SKILL_HINTS = {
    "frontend":        ["react", "javascript", "html", "css"],
    "front end":       ["react", "javascript", "html", "css"],
    "full stack":      ["react", "node", "javascript", "mongodb"],
    "backend":         ["python", "django", "sql", "rest api"],
    "back end":        ["python", "django", "sql", "rest api"],
    "data science":    ["python", "pandas", "machine learning", "sql"],
    "machine learning":["python", "pytorch", "deep learning"],
    "artificial intel":["python", "machine learning", "deep learning"],
    "android":         ["kotlin", "android", "java"],
    "ios":             ["swift", "ios"],
    "ui":              ["figma", "ui/ux"],
    "ux":              ["figma", "ui/ux"],
    "data analyst":    ["sql", "excel", "tableau"],
    "data analytics":  ["sql", "excel", "tableau"],
    "devops":          ["docker", "aws", "linux"],
    "cloud":           ["aws", "docker", "linux"],
    "marketing":       ["marketing", "seo"],
    "flutter":         ["flutter", "firebase"],
    "react native":    ["react native", "javascript"],
    "react":           ["react", "javascript"],
    "node":            ["node", "javascript"],
    "django":          ["python", "django"],
    "python":          ["python", "sql"],
    "web":             ["html", "css", "javascript"],
    "java":            ["java", "spring"],
    "software":        ["programming", "data structures", "git"],
    "sde":             ["programming", "data structures", "git"],
}


def _infer_skills(title: str) -> list[str]:
    """Best-effort guess at what a role wants, from its title alone.

    Returns [] — not a placeholder — when nothing is recognised. It used to
    return ["communication"], which the matcher then read as a real requirement
    the candidate didn't have, dragging every unrecognised title (e.g. "React JS
    Development Internship", which no hint matched) down to a near-zero role-skill
    score. An empty list means "requirements unknown", and matcher.score_job
    scores on the candidate's own relevance signal instead of inventing a miss.
    """
    low = (title or "").lower()
    out: list[str] = []
    for k, v in _SKILL_HINTS.items():
        if k in low:
            for s in v:
                if s not in out:
                    out.append(s)
    return out
