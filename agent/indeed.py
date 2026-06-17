"""Indeed India internship driver (Playwright, persistent browser profile per user).

fetch()  -> scrape listings from in.indeed.com
apply()  -> submit via Indeed Easy Apply (requires login session)
close()  -> release browser context

Returns (status, reason) where status in {applied, login_required, skipped, failed}.
Indeed has aggressive bot detection — we use realistic user agent and delays.
"""
from __future__ import annotations
import os
import re
import urllib.parse

BASE = "https://in.indeed.com"

_contexts: dict = {}


def _profile_dir(uid: str) -> str:
    return os.path.join(os.path.dirname(__file__), "browser_profile", uid or "shared", "indeed")


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
            "--disable-web-security",
        ],
        user_agent=(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        viewport={"width": 1280, "height": 900},
        locale="en-IN",
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
    kw = urllib.parse.quote(f"{domains[0]} internship" if domains else "internship")
    return f"{BASE}/jobs?q={kw}&l=India&sc=0kf%3Aattr%28DSQF7%29%3B"


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    try:
        page.goto(_search_url(domains), wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3500)

        cards = page.query_selector_all(".job_seen_beacon, [data-jk], .resultContent")
        for card in cards:
            if len(jobs) >= limit:
                break
            try:
                title_el = _qsel(card, [
                    "h2.jobTitle span[title]",
                    "h2 a[data-jk]",
                    "h2 span:not([class*='sr'])",
                    ".jobTitle",
                ])
                title = (title_el.get_attribute("title") or title_el.inner_text() or "").strip() \
                    if title_el else ""
                company = _text(card, [
                    ".companyName",
                    "[data-testid='company-name']",
                    "span.companyName",
                ])
                location = _text(card, [
                    ".companyLocation",
                    "[data-testid='text-location']",
                ])
                salary = _text(card, [".salary-snippet-container", ".metadata.salary-snippet"])
                jk = card.get_attribute("data-jk")
                if not jk:
                    link = _qsel(card, ["h2 a", "a.jcs-JobTitle"])
                    if link:
                        href = link.get_attribute("href") or ""
                        m = re.search(r"jk=([a-z0-9]+)", href)
                        jk = m.group(1) if m else ""
                if not title or not jk:
                    continue
                url = f"{BASE}/viewjob?jk={jk}"
                jobs.append({
                    "source": "indeed",
                    "external_id": jk,
                    "title": title,
                    "company": company or "Unknown",
                    "location": location or "",
                    "stipend": salary or "",
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
        page.wait_for_timeout(2500)

        if _is_logged_out(page):
            return "login_required", "not signed in to Indeed — reconnect in the Integrations tab"

        already = page.query_selector(":text('Applied'), :text('Application submitted')")
        if already:
            return "skipped", "already applied on Indeed"

        btn = _qsel(page, [
            "button:has-text('Easily apply')",
            "button:has-text('Apply now')",
            "button:has-text('Apply')",
            "#indeedApplyButton",
            "[class*='apply-button']",
        ])
        if not btn:
            return "skipped", "no Indeed Easy Apply button (external application link)"
        btn.click()
        page.wait_for_timeout(2500)

        # Indeed Easy Apply opens a modal/iframe
        # Fill questions step by step
        for _ in range(5):
            ta = _qsel(page, [
                "textarea[name*='cover']",
                "textarea",
            ])
            if ta:
                try:
                    if not ta.input_value():
                        ta.fill(cover_letter[:2000])
                except Exception:  # noqa: BLE001
                    pass

            for inp in page.query_selector_all("input[type='text'], input[type='number']"):
                try:
                    if not inp.input_value() and inp.is_visible():
                        ph = inp.get_attribute("placeholder") or ""
                        if "year" in ph.lower() or "experience" in ph.lower():
                            inp.fill("0")
                        elif "name" in ph.lower():
                            pass  # skip name fields
                        else:
                            inp.fill("0")
                except Exception:  # noqa: BLE001
                    pass

            next_btn = _qsel(page, [
                "button:has-text('Continue')",
                "button:has-text('Next')",
                "button:has-text('Review')",
                "button:has-text('Submit')",
                "button[type='submit']",
            ])
            if not next_btn:
                break
            label = (next_btn.inner_text() or "").lower()
            next_btn.click()
            page.wait_for_timeout(1500)
            if "submit" in label:
                break

        if page.query_selector(":text('Application submitted'), :text('applied')"):
            return "applied", "submitted via Indeed Easy Apply"
        return "applied", "submitted on Indeed (confirmation not detected)"
    except Exception as e:  # noqa: BLE001
        return "failed", f"indeed error: {str(e)[:120]}"
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass


# ---------- helpers ----------

def _is_logged_out(page) -> bool:
    try:
        html = page.content().lower()
        return "sign in" in html and "my jobs" not in html and "account" not in html
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
    "devops": ["docker", "aws", "linux"],
    "flutter": ["flutter", "firebase"],
    "web": ["html", "css", "javascript"],
    "java": ["java", "spring"],
    "react": ["react", "javascript"],
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
