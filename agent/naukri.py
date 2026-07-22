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
import urllib.parse

import safety
import selector_ai
import stealth

BASE = "https://www.naukri.com"

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
    return os.path.join(_profile_base(), uid or "shared", "naukri")


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
            args=["--disable-blink-features=AutomationControlled"],
            user_agent=stealth.random_ua(),
            viewport=stealth.random_viewport(),
        )
        stealth.apply_stealth(ctx)
    except Exception:  # noqa: BLE001
        # Stop the just-started driver instead of leaking it; a leaked pw poisons
        # this thread's asyncio loop for the next sync_playwright().start().
        try:
            pw.stop()
        except Exception:  # noqa: BLE001
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
        except Exception:  # noqa: BLE001
            pass
        # Stop the driver too — ctx.close() alone leaves the sync_playwright node
        # process running, which accumulates over the long-lived --serve worker.
        try:
            pw.stop()
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
    seen_ids: set[str] = set()
    try:
        for pnum in range(1, 4):  # pages 1-3
            if len(jobs) >= limit:
                break
            base = _search_url(domains)
            page_url = base if pnum == 1 else f"{base}?pageNo={pnum}"
            page.goto(page_url, wait_until="domcontentloaded", timeout=45000)
            delay = stealth.random_delay_ms(2000, 5000) if pnum == 1 else stealth.random_delay_ms(1200, 3000)
            page.wait_for_timeout(delay)

            cards = page.query_selector_all(
                "article.jobTuple, .cust-job-tuple, [class*='job-tuple'], "
                ".srp-jobtuple-wrapper, [data-job-id]"
            )
            new_this_page = 0
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
                    job_url = href if href.startswith("http") else BASE + href
                    m = re.search(r"-(\d+)(?:/)?$", href)
                    jid = m.group(1) if m else str(abs(hash(job_url)))
                    if jid in seen_ids:
                        continue
                    seen_ids.add(jid)
                    jobs.append({
                        "source": "naukri",
                        "external_id": jid,
                        "title": title,
                        "company": company or "Unknown",
                        "location": location or "",
                        "stipend": stipend or "",
                        "duration": "",
                        "skills": _infer_skills(title),
                        "url": job_url,
                    })
                    new_this_page += 1
                except Exception:  # noqa: BLE001
                    continue
            if new_this_page == 0:
                break  # no new results on this page, stop paginating
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
            ".dang-inner-html",
            "[class*='job-desc']",
            ".job-description",
            "[class*='jobDescription']",
            "[itemprop='description']",
            "section[class*='desc']",
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

    manual_final_submit, hold_reason = safety.requires_manual_final_submit("naukri")
    if manual_final_submit:
        return "needs_review", hold_reason
    phone = (profile or {}).get("phone") or ""
    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(stealth.random_delay_ms())

        if safety.detect_challenge(page):
            safety.screenshot(page, uid, f"captcha_naukri_{job.get('external_id','')}")
            return "failed", "captcha challenge on Naukri"

        if _is_logged_out(page):
            return "login_required", "not signed in to Naukri — reconnect in the Integrations tab"

        already = _qsel(page, [":text('Applied')", ":text('Already applied')"])
        if already:
            return "skipped", "already applied on Naukri"

        btn = selector_ai.find_element(page, "Apply or Apply now button", [
            "button:has-text('Apply')",
            "button:has-text('Apply now')",
            "[class*='apply-button']",
            "#apply-button",
            "a:has-text('Apply')",
        ])
        if not btn:
            safety.screenshot(page, uid, f"no_apply_btn_naukri_{job.get('external_id','')}")
            return "skipped", "unsupported Naukri application flow (no direct apply button)"
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

        cl = selector_ai.find_element(page, "cover letter textarea", [
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
                if ta.is_visible() and not ta.input_value():
                    return "skipped", "complex Naukri application has custom written questions"
            except Exception:  # noqa: BLE001
                pass

        if phone:
            for inp in page.query_selector_all("input[type='tel'], input[type='text']"):
                try:
                    lbl = (inp.get_attribute("placeholder") or inp.get_attribute("aria-label") or "").lower()
                    if ("phone" in lbl or "mobile" in lbl) and not inp.input_value():
                        inp.fill(phone)
                except Exception:  # noqa: BLE001
                    pass

        submit = selector_ai.find_element(page, "Submit or Apply button to confirm application", [
            "button:has-text('Submit')",
            "button:has-text('Apply')",
            "input[type='submit']",
            "button[type='submit']",
        ])
        if not submit:
            safety.screenshot(page, uid, f"no_submit_naukri_{job.get('external_id','')}")
            return "skipped", "complex Naukri application requires manual completion"
        stealth.scroll_to(page, submit)
        stealth.human_click(page, submit)
        page.wait_for_timeout(stealth.random_delay_ms())

        return safety.classify_submit(page, [
            ":text('successfully')", ":text('Applied')", ":text('Thank you')",
        ])
    except Exception as e:  # noqa: BLE001
        try:
            safety.screenshot(page, uid, f"exception_naukri_{job.get('external_id','')}")
        except Exception:  # noqa: BLE001
            pass
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
