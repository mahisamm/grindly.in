"""Naukri internship driver (Playwright, persistent browser profile per user).

fetch()  -> scrape listing cards from naukri.com/internship
apply()  -> submit application (requires prior login session)
close()  -> release browser context

Returns (status, reason) where status in {applied, login_required, skipped, failed}.
Selectors are defensive with fallbacks; Naukri's DOM shifts often.
"""
from __future__ import annotations
import os
import re
import time
import urllib.parse

BASE = "https://www.naukri.com"

_contexts: dict = {}


def _profile_dir(uid: str) -> str:
    base = os.path.join(os.path.dirname(__file__), "browser_profile")
    return os.path.join(base, uid or "shared", "naukri")


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
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
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
        kw = urllib.parse.quote(domains[0].lower().replace(" ", "-"))
        return f"{BASE}/internship/jobs-in-india-{kw}"
    return f"{BASE}/internship/jobs-in-india"


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    try:
        page.goto(_search_url(domains), wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3000)

        cards = page.query_selector_all(
            "article.jobTuple, .cust-job-tuple, [class*='job-tuple'], "
            ".srp-jobtuple-wrapper, [data-job-id]"
        )
        for card in cards:
            if len(jobs) >= limit:
                break
            try:
                title_el = _qsel(card, [".title a", "a.title", "[class*='title'] a", "a[href*='-intern']"])
                title = (title_el.inner_text() or "").strip() if title_el else ""
                company = _text(card, [".comp-name", "[class*='comp-name']", ".subTitle", "[class*='company']"])
                location = _text(card, [".location a", ".location", "[class*='location']"])
                stipend = _text(card, [".salary", "[class*='salary']", ".stipend"])
                href = title_el.get_attribute("href") if title_el else None
                if not title or not href:
                    continue
                url = href if href.startswith("http") else BASE + href
                m = re.search(r"-(\d+)(?:/)?$", href)
                jid = m.group(1) if m else str(abs(hash(url)))
                jobs.append({
                    "source": "naukri",
                    "external_id": jid,
                    "title": title,
                    "company": company or "Unknown",
                    "location": location or "",
                    "stipend": stipend or "",
                    "duration": "",
                    "skills": _infer_skills(title),
                    "url": url,
                })
            except Exception:  # noqa: BLE001
                continue
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
    return jobs


def apply(job: dict, cover_letter: str, uid: str = "") -> tuple[str, str]:
    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2000)

        if _is_logged_out(page):
            return "login_required", "not signed in to Naukri — reconnect in the Integrations tab"

        already = _qsel(page, [":text('Applied')", ":text('Already applied')"])
        if already:
            return "skipped", "already applied on Naukri"

        btn = _qsel(page, [
            "button:has-text('Apply')",
            "button:has-text('Apply now')",
            "[class*='apply-button']",
            "#apply-button",
            "a:has-text('Apply')",
        ])
        if not btn:
            return "failed", "apply button not found on Naukri"
        btn.click()
        page.wait_for_timeout(2000)

        cl = _qsel(page, [
            "textarea[name*='cover']",
            "textarea[placeholder*='cover']",
            "textarea[placeholder*='Cover']",
        ])
        if cl:
            try:
                cl.fill(cover_letter[:2000])
            except Exception:  # noqa: BLE001
                pass

        for ta in page.query_selector_all("textarea:not([name*='cover'])"):
            try:
                if not ta.input_value():
                    ta.fill(
                        "I am highly motivated and a fast learner eager "
                        "to contribute from day one."
                    )
            except Exception:  # noqa: BLE001
                pass

        submit = _qsel(page, [
            "button:has-text('Submit')",
            "button:has-text('Apply')",
            "input[type='submit']",
            "button[type='submit']",
        ])
        if not submit:
            return "failed", "submit button not found on Naukri"
        submit.click()
        page.wait_for_timeout(2500)

        if page.query_selector(":text('successfully'), :text('Applied'), :text('Thank you')"):
            return "applied", "submitted via Naukri"
        return "applied", "submitted on Naukri (confirmation not detected)"
    except Exception as e:  # noqa: BLE001
        return "failed", f"naukri error: {str(e)[:120]}"
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass


# ---------- helpers ----------

def _is_logged_out(page) -> bool:
    try:
        html = page.content().lower()
        return (
            ("login" in html or "sign in" in html)
            and "logout" not in html
            and "my account" not in html
        )
    except Exception:  # noqa: BLE001
        return False


def _qsel(scope, selectors: list[str]):
    for s in selectors:
        try:
            el = scope.query_selector(s)
            if el:
                return el
        except Exception:  # noqa: BLE001
            continue
    return None


def _text(scope, selectors: list[str]) -> str:
    for s in selectors:
        try:
            el = scope.query_selector(s)
            if el:
                t = (el.inner_text() or "").strip()
                if t:
                    return re.sub(r"\s+", " ", t)
        except Exception:  # noqa: BLE001
            continue
    return ""


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
    "flutter": ["flutter", "firebase"],
    "python": ["python", "sql"],
    "web": ["html", "css", "javascript"],
    "java": ["java", "spring"],
    "react": ["react", "javascript"],
    "node": ["node", "javascript"],
    "marketing": ["marketing", "seo"],
    "content": ["content writing", "seo"],
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
