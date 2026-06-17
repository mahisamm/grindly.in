"""Live Internshala driver (Playwright, headed, persistent profile).

Two jobs:
  fetch()  -> scrape public listing cards into the same dict shape as mockboard.
  apply()  -> best-effort: open the detail page and submit the apply form.
              Internshala requires a logged-in account; the persistent profile
              (browser_profile/) means the user logs in ONCE and the agent
              reuses the session. If not logged in, apply() returns 'login_required'
              instead of pretending it applied.

Selectors are defensive with fallbacks because Internshala's DOM shifts. When a
selector misses, we degrade to 'matched' rather than crash the run.
"""
from __future__ import annotations
import os
import re
import time
import urllib.parse

BASE = "https://internshala.com"

# Legacy single profile dir kept for connect_internshala.py compatibility
PROFILE_DIR = os.path.join(os.path.dirname(__file__), "browser_profile", "shared", "internshala")

_contexts: dict = {}


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
        args=["--disable-blink-features=AutomationControlled"],
        viewport={"width": 1280, "height": 900},
    )
    _contexts[key] = ctx
    return ctx


def close(uid: str = ""):
    key = uid or "shared"
    ctx = _contexts.pop(key, None)
    if ctx:
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass


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
        page.wait_for_timeout(2500)
        cards = page.query_selector_all(".individual_internship")
        for c in cards:
            if len(jobs) >= limit:
                break
            try:
                title = _text(c, [".job-internship-name", ".profile", "h3"])
                company = _text(c, [".company-name", ".company_name", "p.company-name"])
                location = _text(c, [".locations", ".location_link", ".row-1-item.locations"])
                stipend = _text(c, [".stipend", ".desktop-stipend"])
                duration = _text(c, [".ic-16-calendar + span", ".item_body"])
                href = c.get_attribute("data-href") or _attr(c, ["a.job-title-href", "a"], "href")
                jid = c.get_attribute("internshipid") or (href or str(len(jobs)))
                if not title or not href:
                    continue
                url = href if href.startswith("http") else BASE + href
                jobs.append({
                    "source": "internshala",
                    "external_id": str(jid),
                    "title": title,
                    "company": company or "Unknown",
                    "location": location or "",
                    "stipend": stipend or "",
                    "duration": duration or "",
                    "skills": _infer_skills(title),
                    "url": url,
                })
            except Exception:  # noqa: BLE001
                continue
    finally:
        page.close()
    return jobs


def apply(job: dict, cover_letter: str, uid: str = "") -> tuple[str, str]:
    """Return (status, reason). status in {applied, login_required, skipped, failed}."""
    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(1500)

        if _is_logged_out(page):
            return "login_required", "not signed in to Internshala (log in once in the agent browser)"

        btn = _first(page, ["#continue_button", "#apply_now_button", "button:has-text('Apply now')"])
        if not btn:
            if page.query_selector(":text('Application sent')") or page.query_selector(":text('Already applied')"):
                return "skipped", "already applied"
            return "failed", "apply button not found"
        btn.click()
        page.wait_for_timeout(1500)

        # cover letter
        cl = _first(page, ["#cover_letter_box", "textarea[name='cover_letter']", "div[contenteditable='true']"])
        if cl:
            try:
                cl.fill(cover_letter)
            except Exception:  # noqa: BLE001
                cl.click()
                page.keyboard.type(cover_letter[:1500])

        # generic answers for required assessment text fields
        for ta in page.query_selector_all("textarea"):
            try:
                if not ta.input_value():
                    ta.fill("I'm genuinely excited about this role and a fast learner ready to contribute from day one.")
            except Exception:  # noqa: BLE001
                pass

        submit = _first(page, ["#submit", "button:has-text('Submit application')", "input[type='submit']"])
        if not submit:
            return "failed", "submit button not found (form may need extra fields)"
        submit.click()
        page.wait_for_timeout(2500)

        if page.query_selector(":text('Application sent')") or page.query_selector(":text('successfully')"):
            return "applied", "submitted via Internshala"
        return "applied", "submitted (confirmation not detected)"
    except Exception as e:  # noqa: BLE001
        return "failed", f"error: {str(e)[:120]}"
    finally:
        page.close()


# ---------- helpers ----------

def _is_logged_out(page) -> bool:
    html = page.content().lower()
    return ("login" in html and "register" in html and "logout" not in html) or \
        bool(page.query_selector("a[href*='login']:visible"))


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
        except Exception:  # noqa: BLE001
            continue
    return None


_SKILL_HINTS = {
    "frontend": ["react", "javascript", "html", "css"],
    "full stack": ["react", "node", "javascript", "mongodb"],
    "backend": ["python", "django", "sql", "rest api"],
    "data science": ["python", "pandas", "machine learning", "sql"],
    "machine learning": ["python", "pytorch", "deep learning"],
    "android": ["kotlin", "android", "java"],
    "ui": ["figma", "ui/ux"], "ux": ["figma", "ui/ux"],
    "data analyst": ["sql", "excel", "tableau"],
    "devops": ["docker", "aws", "linux"],
    "marketing": ["marketing", "seo"],
    "flutter": ["flutter", "firebase"], "python": ["python", "sql"],
    "web": ["html", "css", "javascript"], "java": ["java", "spring"],
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
