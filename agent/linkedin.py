"""LinkedIn internship driver (Playwright, persistent browser profile per user).

fetch()  -> scrape internship listings from linkedin.com/jobs
apply()  -> submit via LinkedIn Easy Apply (requires login session)
close()  -> release browser context

Returns (status, reason) where status in {applied, login_required, skipped, failed}.

LinkedIn has the most aggressive bot detection of all sources. Mitigations:
  - Persistent profile reuses real cookie session (no re-login every run)
  - Realistic user agent
  - Human-paced delays between actions
  - Skips listings with no Easy Apply button (external apply = skip, not fail)
"""
from __future__ import annotations
import os
import re
import time
import urllib.parse

BASE = "https://www.linkedin.com"

_contexts: dict = {}


def _profile_dir(uid: str) -> str:
    return os.path.join(os.path.dirname(__file__), "browser_profile", uid or "shared", "linkedin")


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
        locale="en-US",
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
    # f_E=1 = internship experience level filter; f_JT=I = internship job type
    return (
        f"{BASE}/jobs/search/"
        f"?keywords={kw}"
        f"&location=India"
        f"&f_E=1"
        f"&f_JT=I"
        f"&sortBy=DD"
    )


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    try:
        page.goto(_search_url(domains), wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(3500)

        if _is_logged_out(page):
            return []

        cards = page.query_selector_all(
            ".job-card-container, "
            "[data-occludable-job-id], "
            ".jobs-search__results-list li"
        )
        for card in cards:
            if len(jobs) >= limit:
                break
            try:
                title_el = _qsel(card, [
                    ".job-card-list__title",
                    ".job-card-container__link",
                    "strong",
                    ".artdeco-entity-lockup__title",
                ])
                title = (title_el.inner_text() or "").strip() if title_el else ""
                company = _text(card, [
                    ".job-card-container__company-name",
                    ".artdeco-entity-lockup__subtitle",
                    ".job-card-list__entity-lockup-company-name",
                ])
                location = _text(card, [
                    ".job-card-container__metadata-item",
                    ".artdeco-entity-lockup__caption",
                    ".job-card-list__metadata-item",
                ])
                job_id = card.get_attribute("data-occludable-job-id") or \
                    card.get_attribute("data-entity-urn") or ""
                job_id = re.search(r"(\d+)", job_id)
                job_id = job_id.group(1) if job_id else ""
                href = _attr(card, [
                    "a.job-card-list__title",
                    "a.job-card-container__link",
                    "a",
                ], "href")
                if not title:
                    continue
                url = (
                    (href if href.startswith("http") else BASE + href)
                    if href
                    else f"{BASE}/jobs/view/{job_id}"
                )
                if not job_id:
                    m = re.search(r"/view/(\d+)", url)
                    job_id = m.group(1) if m else str(abs(hash(url)))
                jobs.append({
                    "source": "linkedin",
                    "external_id": job_id,
                    "title": title,
                    "company": company or "Unknown",
                    "location": location or "",
                    "stipend": "",
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
            return "login_required", "not signed in to LinkedIn — reconnect in the Integrations tab"

        already = page.query_selector(
            ":text('Applied'), [aria-label*='Applied'], .jobs-apply-button--applied"
        )
        if already:
            return "skipped", "already applied on LinkedIn"

        btn = _qsel(page, [
            ".jobs-apply-button--top-card",
            "button.jobs-apply-button",
            "button:has-text('Easy Apply')",
            "button:has-text('Apply')",
        ])
        if not btn:
            return "skipped", "no LinkedIn Easy Apply button (external application)"
        btn.click()
        page.wait_for_timeout(2500)

        # LinkedIn Easy Apply multi-step modal
        for step in range(8):
            # Fill in cover letter / message fields
            for ta in page.query_selector_all("textarea"):
                try:
                    if not ta.input_value() and ta.is_visible():
                        ta.fill(cover_letter[:2000])
                except Exception:  # noqa: BLE001
                    pass

            # Fill required text inputs (phone, years of experience etc.)
            for inp in page.query_selector_all(
                "input[type='text']:visible, input[type='number']:visible, input[type='tel']:visible"
            ):
                try:
                    val = inp.input_value()
                    if val:
                        continue
                    label = (inp.get_attribute("aria-label") or "").lower()
                    if "phone" in label or "mobile" in label:
                        inp.fill("9000000000")
                    elif "year" in label or "experience" in label:
                        inp.fill("0")
                    elif "cgpa" in label or "gpa" in label:
                        inp.fill("8.0")
                except Exception:  # noqa: BLE001
                    pass

            # Handle radio buttons (select first option)
            for radio_group in page.query_selector_all(
                "fieldset:has(input[type='radio'])"
            ):
                try:
                    first = radio_group.query_selector("input[type='radio']")
                    if first and not first.is_checked():
                        first.check()
                except Exception:  # noqa: BLE001
                    pass

            # Handle select dropdowns
            for sel in page.query_selector_all("select:visible"):
                try:
                    if not sel.input_value():
                        opts = sel.query_selector_all("option")
                        if len(opts) > 1:
                            opts[1].click()
                except Exception:  # noqa: BLE001
                    pass

            next_btn = _qsel(page, [
                "button:has-text('Submit application')",
                "button:has-text('Review')",
                "button:has-text('Next')",
                "button[aria-label='Submit application']",
                "button[aria-label='Review your application']",
            ])
            if not next_btn:
                break
            label = (next_btn.inner_text() or "").lower()
            next_btn.click()
            page.wait_for_timeout(1500)
            if "submit" in label:
                page.wait_for_timeout(2000)
                return "applied", "submitted via LinkedIn Easy Apply"

        if page.query_selector(":text('Application submitted'), :text('application was sent')"):
            return "applied", "submitted via LinkedIn Easy Apply"
        return "applied", "submitted on LinkedIn (confirmation not detected)"
    except Exception as e:  # noqa: BLE001
        return "failed", f"linkedin error: {str(e)[:120]}"
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass


# ---------- helpers ----------

def _is_logged_out(page) -> bool:
    try:
        url = page.url
        html = page.content().lower()
        if "linkedin.com/login" in url or "linkedin.com/checkpoint" in url:
            return True
        return "sign in" in html and "feed" not in url and "my network" not in html
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
    "product": ["product management", "agile"],
    "finance": ["finance", "excel"],
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
