"""Unstop (unstop.com) internship driver (Playwright, persistent browser profile per user).

fetch()  -> scrape internship listings from unstop.com
apply()  -> submit application (requires login session)
close()  -> release browser context

Returns (status, reason) where status in {applied, login_required, skipped, failed}.
"""
from __future__ import annotations
import os
import re
import time

BASE = "https://unstop.com"

_contexts: dict = {}


def _profile_dir(uid: str) -> str:
    return os.path.join(os.path.dirname(__file__), "browser_profile", uid or "shared", "unstop")


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
        kw = domains[0].lower().replace(" ", "%20")
        return f"{BASE}/internships?q={kw}"
    return f"{BASE}/internships"


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    try:
        page.goto(_search_url(domains), wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(4000)

        # Unstop is a React SPA; wait for cards to hydrate
        cards = page.query_selector_all(
            ".opportunity-card-new, .opportunity-card, "
            "[class*='opportunityCard'], [class*='opportunity-card'], "
            "app-opportunity-card"
        )
        for card in cards:
            if len(jobs) >= limit:
                break
            try:
                title = _text(card, [
                    ".opportunity-title",
                    "[class*='title']",
                    "h3", "h4",
                ])
                company = _text(card, [
                    ".org-name",
                    "[class*='org-name']",
                    "[class*='company']",
                    ".company-name",
                ])
                stipend = _text(card, [
                    "[class*='stipend']",
                    "[class*='salary']",
                    ".salary",
                ])
                href = _attr(card, ["a[href*='/p/']", "a[href*='/internship']", "a"], "href")
                if not title or not href:
                    continue
                url = href if href.startswith("http") else BASE + href
                jid = re.search(r"/p/([^/]+)", href)
                jid = jid.group(1) if jid else str(abs(hash(url)))
                jobs.append({
                    "source": "unstop",
                    "external_id": jid,
                    "title": title,
                    "company": company or "Unknown",
                    "location": "Remote/Onsite",
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
        page.wait_for_timeout(3000)

        if _is_logged_out(page):
            return "login_required", "not signed in to Unstop — reconnect in the Integrations tab"

        already = page.query_selector(":text('Applied'), :text('Registered')")
        if already:
            return "skipped", "already applied on Unstop"

        btn = _qsel(page, [
            "button:has-text('Apply')",
            "button:has-text('Register')",
            "button:has-text('Apply now')",
            "[class*='apply-btn']",
            "[class*='register-btn']",
        ])
        if not btn:
            return "failed", "apply button not found on Unstop"
        btn.click()
        page.wait_for_timeout(2500)

        for ta in page.query_selector_all("textarea"):
            try:
                val = ta.input_value()
                if not val:
                    ta.fill(cover_letter[:1500])
            except Exception:  # noqa: BLE001
                pass

        submit = _qsel(page, [
            "button:has-text('Submit')",
            "button:has-text('Apply')",
            "button:has-text('Register')",
            "button[type='submit']",
        ])
        if not submit:
            return "failed", "submit button not found on Unstop"
        submit.click()
        page.wait_for_timeout(2500)

        if page.query_selector(":text('successfully'), :text('Applied'), :text('Registered')"):
            return "applied", "submitted via Unstop"
        return "applied", "submitted on Unstop (confirmation not detected)"
    except Exception as e:  # noqa: BLE001
        return "failed", f"unstop error: {str(e)[:120]}"
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
            ("login" in html or "sign in" in html or "sign up" in html)
            and "profile" not in html
            and "dashboard" not in html
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


def _attr(scope, selectors: list[str], attr: str):
    for s in selectors:
        try:
            el = scope.query_selector(s)
            if el:
                v = el.get_attribute(attr)
                if v:
                    return v
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
    "devops": ["docker", "aws", "linux"],
    "flutter": ["flutter", "firebase"],
    "web": ["html", "css", "javascript"],
    "java": ["java", "spring"],
    "react": ["react", "javascript"],
    "marketing": ["marketing", "seo"],
    "content": ["content writing", "seo"],
    "finance": ["finance", "excel"],
    "hr": ["hr", "communication"],
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
