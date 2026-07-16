"""Unstop (unstop.com) internship driver (Playwright, persistent browser profile per user).

fetch()  -> scrape internship listings from unstop.com
apply()  -> submit application (requires login session)
close()  -> release browser context

Returns (status, reason) where status in {applied, login_required, skipped, failed}.
"""
from __future__ import annotations
import os
import re

import safety
import selector_ai
import stealth

BASE = "https://unstop.com"

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
    return os.path.join(_profile_base(), uid or "shared", "unstop")


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


def _search_url(domains: list[str]) -> str:
    if domains:
        kw = domains[0].lower().replace(" ", "%20")
        return f"{BASE}/internships?q={kw}"
    return f"{BASE}/internships"


def _extract_cards(page, limit: int, seen_ids: set, jobs: list) -> int:
    """Parse opportunity cards from current page state into jobs list. Returns count added."""
    cards = page.query_selector_all(
        ".opportunity-card-new, .opportunity-card, "
        "[class*='opportunityCard'], [class*='opportunity-card'], "
        "app-opportunity-card"
    )
    added = 0
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
            jid_m = re.search(r"/p/([^/]+)", href)
            jid = jid_m.group(1) if jid_m else str(abs(hash(url)))
            if jid in seen_ids:
                continue
            seen_ids.add(jid)
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
            added += 1
        except Exception:  # noqa: BLE001
            continue
    return added


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    page = _context(uid).new_page()
    jobs: list[dict] = []
    seen_ids: set[str] = set()
    try:
        page.goto(_search_url(domains), wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(stealth.random_delay_ms(2500, 5500))

        # Unstop is a React SPA — wait for cards to hydrate, then try load-more
        _extract_cards(page, limit, seen_ids, jobs)

        if len(jobs) < limit:
            load_more = _qsel(page, [
                "button:has-text('Load more')",
                "button:has-text('Show more')",
                "button:has-text('View more')",
                "[class*='load-more']",
                "[class*='loadMore']",
            ])
            if load_more:
                try:
                    load_more.click()
                    page.wait_for_timeout(stealth.random_delay_ms(1500, 3000))
                    _extract_cards(page, limit, seen_ids, jobs)
                except Exception:  # noqa: BLE001
                    pass
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
        page.wait_for_timeout(stealth.random_delay_ms(1000, 2500))  # SPA needs hydration
        return _text(page, [
            "[class*='description']",
            "[class*='about-opportunity']",
            ".opportunity-description",
            "[class*='job-desc']",
            "[class*='jobDesc']",
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

    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(stealth.random_delay_ms())

        if safety.detect_challenge(page):
            safety.screenshot(page, uid, f"captcha_unstop_{job.get('external_id','')}")
            return "failed", "captcha challenge on Unstop"

        if _is_logged_out(page):
            return "login_required", "not signed in to Unstop — reconnect in the Integrations tab"

        already = page.query_selector(":text('Applied'), :text('Registered')")
        if already:
            return "skipped", "already applied on Unstop"

        btn = selector_ai.find_element(page, "Apply, Register or Apply now button", [
            "button:has-text('Apply')",
            "button:has-text('Register')",
            "button:has-text('Apply now')",
            "[class*='apply-btn']",
            "[class*='register-btn']",
        ])
        if not btn:
            safety.screenshot(page, uid, f"no_apply_btn_unstop_{job.get('external_id','')}")
            return "failed", "apply button not found on Unstop"
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

        for ta in page.query_selector_all("textarea"):
            try:
                val = ta.input_value()
                if not val:
                    ta.fill(cover_letter[:1500])
            except Exception:  # noqa: BLE001
                pass

        submit = selector_ai.find_element(page, "Submit, Apply or Register confirmation button", [
            "button:has-text('Submit')",
            "button:has-text('Apply')",
            "button:has-text('Register')",
            "button[type='submit']",
        ])
        if not submit:
            safety.screenshot(page, uid, f"no_submit_unstop_{job.get('external_id','')}")
            return "failed", "submit button not found on Unstop"
        stealth.scroll_to(page, submit)
        stealth.human_click(page, submit)
        page.wait_for_timeout(stealth.random_delay_ms())

        return safety.classify_submit(page, [
            ":text('successfully')", ":text('Applied')", ":text('Registered')",
        ])
    except Exception as e:  # noqa: BLE001
        try:
            safety.screenshot(page, uid, f"exception_unstop_{job.get('external_id','')}")
        except Exception:  # noqa: BLE001
            pass
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
