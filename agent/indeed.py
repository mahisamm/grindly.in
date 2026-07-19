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

import safety
import selector_ai
import stealth

BASE = "https://in.indeed.com"

_contexts: dict = {}


def _profile_base() -> str:
    """Root dir holding per-user persistent browser profiles — must be a
    volume shared between the web app and every worker replica, or a session
    saved by one container is invisible to the next. See internshala.py's
    _profile_base() for the full rationale; override with GRINDLY_PROFILE_BASE."""
    env = os.environ.get("GRINDLY_PROFILE_BASE")
    if env:
        return env
    return os.path.join(os.path.dirname(__file__), "..", "data", "browser_profile")


def _profile_dir(uid: str) -> str:
    return os.path.join(_profile_base(), uid or "shared", "indeed")


def _context(uid: str = ""):
    key = uid or "shared"
    if key in _contexts:
        return _contexts[key]
    from playwright.sync_api import sync_playwright
    profile = _profile_dir(uid)
    os.makedirs(profile, exist_ok=True)
    stealth.clear_stale_lock(profile)
    pw = sync_playwright().start()
    ctx = pw.chromium.launch_persistent_context(
        profile,
        headless=os.environ.get("INTERNPILOT_HEADLESS", "0") == "1",
        args=["--disable-blink-features=AutomationControlled"],
        user_agent=stealth.random_ua(),
        viewport=stealth.random_viewport(),
        locale="en-IN",
    )
    stealth.apply_stealth(ctx)
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


def _search_url(domains: list[str], start: int = 0) -> str:
    kw = urllib.parse.quote(f"{domains[0]} internship" if domains else "internship")
    base = f"{BASE}/jobs?q={kw}&l=India&sc=0kf%3Aattr%28DSQF7%29%3B"
    return base + (f"&start={start}" if start > 0 else "")


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    seen_jks: set[str] = set()
    try:
        for pnum in range(1, 4):  # pages 1-3 (Indeed paginates by 25)
            if len(jobs) >= limit:
                break
            page_url = _search_url(domains, start=(pnum - 1) * 25)
            page.goto(page_url, wait_until="domcontentloaded", timeout=45000)
            delay = stealth.random_delay_ms(2000, 5500) if pnum == 1 else stealth.random_delay_ms(1500, 4000)
            page.wait_for_timeout(delay)

            cards = page.query_selector_all(".job_seen_beacon, [data-jk], .resultContent")
            new_this_page = 0
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
                    if not title or not jk or jk in seen_jks:
                        continue
                    seen_jks.add(jk)
                    jobs.append({
                        "source": "indeed",
                        "external_id": jk,
                        "title": title,
                        "company": company or "Unknown",
                        "location": location or "",
                        "stipend": salary or "",
                        "duration": "",
                        "skills": _infer_skills(title),
                        "url": f"{BASE}/viewjob?jk={jk}",
                    })
                    new_this_page += 1
                except Exception:  # noqa: BLE001
                    continue
            if new_this_page == 0:
                break  # no new results, stop paginating
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
    return jobs


def scrape_jd(url: str, uid: str = "") -> str:
    """Extract job description text from a listing page. Returns '' on failure."""
    page = _context(uid).new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=25000)
        page.wait_for_timeout(stealth.random_delay_ms(600, 1500))
        return _text(page, [
            "#jobDescriptionText",
            ".jobsearch-jobDescriptionText",
            "[class*='jobDescription']",
            "[class*='job-description']",
            ".jobDescription",
        ])[:1500]
    except Exception:  # noqa: BLE001
        return ""
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass


def apply(job: dict, cover_letter: str, uid: str = "",
          profile: dict | None = None, resume_path: str | None = None,
          record: dict | None = None) -> tuple[str, str]:
    # `record` is an optional out-parameter shared by every platform adapter (see
    # internshala.apply). This adapter does not populate it yet; accepting it keeps
    # the call shape uniform so the worker can pass it to all five without a branch.

    manual_final_submit, hold_reason = safety.requires_manual_final_submit("indeed")
    if manual_final_submit:
        return "needs_review", hold_reason
    phone = (profile or {}).get("phone") or ""
    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(stealth.random_delay_ms())

        if safety.detect_challenge(page):
            safety.screenshot(page, uid, f"captcha_indeed_{job.get('external_id','')}")
            return "failed", "captcha challenge on Indeed"

        if _is_logged_out(page):
            return "login_required", "not signed in to Indeed — reconnect in the Integrations tab"

        already = page.query_selector(":text('Applied'), :text('Application submitted')")
        if already:
            return "skipped", "already applied on Indeed"

        btn = selector_ai.find_element(page, "Easily apply, Apply now, or Apply button", [
            "button:has-text('Easily apply')",
            "button:has-text('Apply now')",
            "button:has-text('Apply')",
            "#indeedApplyButton",
            "[class*='apply-button']",
        ])
        if not btn:
            return "skipped", "no Indeed Easy Apply button (external application link)"
        stealth.scroll_to(page, btn)
        stealth.human_click(page, btn)
        page.wait_for_timeout(stealth.random_delay_ms())

        if resume_path and os.path.isfile(resume_path):
            file_inp = _qsel(page, [
                "input[type='file'][accept*='pdf']",
                "input[type='file']",
            ])
            if file_inp:
                try:
                    file_inp.set_input_files(resume_path)
                    page.wait_for_timeout(stealth.random_delay_ms(600, 1800))
                except Exception:  # noqa: BLE001
                    pass

        for _ in range(5):
            ta = _qsel(page, ["textarea[name*='cover']", "textarea"])
            if ta:
                try:
                    if not ta.input_value():
                        ta.fill(cover_letter[:2000])
                except Exception:  # noqa: BLE001
                    pass

            for inp in page.query_selector_all("input[type='text'], input[type='number'], input[type='tel']"):
                try:
                    if not inp.input_value() and inp.is_visible():
                        ph = (inp.get_attribute("placeholder") or "").lower()
                        lbl = (inp.get_attribute("aria-label") or "").lower()
                        hint = ph + " " + lbl
                        if "year" in hint or "experience" in hint:
                            inp.fill("0")
                        elif "phone" in hint or "mobile" in hint:
                            if not phone:
                                return "skipped", "complex Indeed application needs a phone number not present in the profile"
                            inp.fill(phone)
                        elif "name" in hint:
                            pass
                        elif inp.get_attribute("required") is not None or inp.get_attribute("aria-required") == "true":
                            return "skipped", "complex Indeed application has an unsupported required question"
                except Exception:  # noqa: BLE001
                    pass

            next_btn = selector_ai.find_element(
                page,
                "Continue, Next, Review or Submit button in application flow",
                [
                    "button:has-text('Continue')",
                    "button:has-text('Next')",
                    "button:has-text('Review')",
                    "button:has-text('Submit')",
                    "button[type='submit']",
                ],
            )
            if not next_btn:
                break
            label = (next_btn.inner_text() or "").lower()
            stealth.scroll_to(page, next_btn)
            stealth.human_click(page, next_btn)
            page.wait_for_timeout(stealth.random_delay_ms(1000, 2800))
            if "submit" in label:
                break

        return safety.classify_submit(page, [
            ":text('Application submitted')", ":text('applied')",
        ])
    except Exception as e:  # noqa: BLE001
        try:
            safety.screenshot(page, uid, f"exception_indeed_{job.get('external_id','')}")
        except Exception:  # noqa: BLE001
            pass
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
