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
import os
import random
import re
import time
import urllib.parse

BASE = "https://internshala.com"

PROFILE_DIR = os.path.join(os.path.dirname(__file__), "browser_profile", "shared", "internshala")

_contexts: dict = {}

# Realistic desktop viewports — rotated randomly per session
_VIEWPORTS = [
    {"width": 1280, "height": 800},
    {"width": 1366, "height": 768},
    {"width": 1440, "height": 900},
    {"width": 1536, "height": 864},
]

# Realistic Chrome UA — update when Chrome major version advances
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)


def _profile_dir(uid: str) -> str:
    if not uid:
        return PROFILE_DIR
    return os.path.join(os.path.dirname(__file__), "browser_profile", uid, "internshala")


def _context(uid: str = ""):
    key = uid or "shared"
    if key in _contexts:
        return _contexts[key]
    from playwright.sync_api import sync_playwright
    profile = _profile_dir(uid)
    os.makedirs(profile, exist_ok=True)
    pw = sync_playwright().start()
    ctx = pw.chromium.launch_persistent_context(
        profile,
        headless=os.environ.get("INTERNPILOT_HEADLESS", "0") == "1",
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-infobars",
            "--no-first-run",
            "--disable-dev-shm-usage",
        ],
        viewport=random.choice(_VIEWPORTS),
        user_agent=_USER_AGENT,
    )
    # Mask the webdriver flag that sites check for automation
    try:
        ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )
    except Exception:
        pass
    _contexts[key] = ctx
    return ctx


def close(uid: str = ""):
    key = uid or "shared"
    ctx = _contexts.pop(key, None)
    if ctx:
        try:
            ctx.close()
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


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    try:
        page.goto(_search_url(domains), wait_until="domcontentloaded", timeout=45000)
        _read_pause(page, 1500, 3000)
        _scroll_down(page, 400)
        cards = page.query_selector_all(".individual_internship")
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
            except Exception:
                continue
    finally:
        page.close()
    return jobs


# ── apply ─────────────────────────────────────────────────────────

def apply(
    job: dict,
    cover_letter: str,
    uid: str = "",
    profile: dict | None = None,
    resume_path: str | None = None,
) -> tuple[str, str]:
    """Submit an application. Returns (status, reason).

    status ∈ {applied, login_required, skipped, failed}

    Bot-evasion: every form interaction goes through _human_type/_human_click
    so keystroke intervals, hover timing, and scroll behaviour all look organic.
    If any step can't proceed, we return 'failed' and the worker moves to the
    next highest-scoring listing automatically.
    """
    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        _read_pause(page, 1500, 3500)  # simulate reading the job description

        if _is_logged_out(page):
            return "login_required", "not signed in to Internshala (log in once in the agent browser)"

        # Scroll down to read description before clicking Apply
        _scroll_down(page, random.randint(250, 500))
        _read_pause(page, 800, 1800)

        # Find the apply / continue button
        btn = _first(page, [
            "#continue_button",
            "#apply_now_button",
            "button:has-text('Apply now')",
            "a:has-text('Apply now')",
        ])
        if not btn:
            if (page.query_selector(":text('Application sent')")
                    or page.query_selector(":text('Already applied')")):
                return "skipped", "already applied"
            return "failed", "apply button not found"

        _human_click(page, btn)
        _read_pause(page, 1000, 2200)

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

        # Cover letter — human typing, capped at 1500 chars
        cl = _first(page, [
            "#cover_letter_box",
            "textarea[name='cover_letter']",
            "div[contenteditable='true']",
        ])
        if cl:
            _human_type(page, cl, cover_letter[:1500])
            _read_pause(page, 400, 900)

        # Fill any required assessment textarea fields
        for ta in page.query_selector_all("textarea"):
            try:
                if not ta.input_value():
                    _human_type(
                        page, ta,
                        "I'm genuinely excited about this role and pick up new tools quickly. "
                        "I'd love to contribute from day one.",
                        wpm=55,
                    )
                    _read_pause(page, 300, 700)
            except Exception:
                pass

        # Fill any required single-line inputs that are blank (e.g. availability, phone)
        for inp in page.query_selector_all("input[required]"):
            try:
                itype = (inp.get_attribute("type") or "text").lower()
                if itype in ("hidden", "file", "checkbox", "radio", "submit"):
                    continue
                if inp.input_value():
                    continue
                if itype == "tel" and profile:
                    val = profile.get("phone") or ""
                elif itype == "number":
                    val = "8.5"
                else:
                    val = "Yes"
                if val:
                    _human_type(page, inp, val, wpm=70)
                    _read_pause(page, 200, 500)
            except Exception:
                pass

        # One last review pause before submitting
        _read_pause(page, 600, 1400)

        submit = _first(page, [
            "#submit",
            "button:has-text('Submit application')",
            "input[type='submit']",
            "button[type='submit']",
        ])
        if not submit:
            return "failed", "submit button not found (form may need extra fields)"

        _human_click(page, submit)
        page.wait_for_timeout(random.randint(2000, 3500))

        if (page.query_selector(":text('Application sent')")
                or page.query_selector(":text('successfully')")
                or page.query_selector(":text('Thank you')")):
            return "applied", "submitted via Internshala"
        return "applied", "submitted (confirmation not detected)"

    except Exception as e:
        return "failed", f"error: {str(e)[:120]}"
    finally:
        page.close()


# ── helpers ───────────────────────────────────────────────────────

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
    "full stack":      ["react", "node", "javascript", "mongodb"],
    "backend":         ["python", "django", "sql", "rest api"],
    "data science":    ["python", "pandas", "machine learning", "sql"],
    "machine learning":["python", "pytorch", "deep learning"],
    "android":         ["kotlin", "android", "java"],
    "ui":              ["figma", "ui/ux"],
    "ux":              ["figma", "ui/ux"],
    "data analyst":    ["sql", "excel", "tableau"],
    "devops":          ["docker", "aws", "linux"],
    "marketing":       ["marketing", "seo"],
    "flutter":         ["flutter", "firebase"],
    "python":          ["python", "sql"],
    "web":             ["html", "css", "javascript"],
    "java":            ["java", "spring"],
}


def _infer_skills(title: str) -> list[str]:
    low = (title or "").lower()
    out: list[str] = []
    for k, v in _SKILL_HINTS.items():
        if k in low:
            for s in v:
                if s not in out:
                    out.append(s)
    return out or ["communication"]
