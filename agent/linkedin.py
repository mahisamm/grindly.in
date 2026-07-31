"""LinkedIn internship driver (Playwright, persistent browser profile per user).

fetch()  -> scrape internship listings from linkedin.com/jobs (all domains)
apply()  -> submit via LinkedIn Easy Apply (requires login session)
close()  -> release browser context

Returns (status, reason) where status in {applied, login_required, skipped, failed}.

LinkedIn has the most aggressive bot detection of all sources. Mitigations:
  - Persistent profile reuses real cookie session (no re-login every run)
  - Realistic user agent
  - navigator.webdriver patched via CDP init script
  - Randomized human-paced delays between actions
  - Hover before click to mimic real mouse movement
  - Skips listings with no Easy Apply button (external apply = skip, not fail)
"""
from __future__ import annotations
import os
import random
import re
import urllib.parse

import safety
import selector_ai
import stealth

BASE = "https://www.linkedin.com"

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
    return os.path.join(_profile_base(), uid or "shared", "linkedin")


def _context(uid: str = ""):
    key = uid or "shared"
    if key in _contexts:
        return _contexts[key][1]
    from playwright.sync_api import sync_playwright
    profile = _profile_dir(uid)
    os.makedirs(profile, exist_ok=True)
    stealth.clear_stale_lock(profile)
    # Same identity every time this profile is opened — see
    # stealth.profile_identity. A saved session presented from a browser
    # that is not the one it was created in gets dropped by the platform.
    ident = stealth.profile_identity(profile)
    pw = sync_playwright().start()
    try:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=os.environ.get("INTERNPILOT_HEADLESS", "0") == "1",
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--no-sandbox",
            ],
            user_agent=ident["user_agent"],
            viewport=ident["viewport"],
            locale="en-US",
            color_scheme="light",
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


def _rand_delay(page, lo: float = 0.8, hi: float = 2.5):
    page.wait_for_timeout(int(random.uniform(lo, hi) * 1000))


def _safe_click(element, page):
    """Hover then click — more human-like than direct click."""
    try:
        element.hover()
        page.wait_for_timeout(int(random.uniform(150, 400)))
        element.click()
    except Exception:  # noqa: BLE001
        element.click()


def _search_url(keyword: str, start: int = 0) -> str:
    # Public "guest" jobs API — returns job-card HTML with no login/authwall,
    # unlike the /jobs/search app page which walls anonymous scraping. Paginates
    # 25 per request via &start.
    kw = urllib.parse.quote(f"{keyword} internship")
    return (
        f"{BASE}/jobs-guest/jobs/api/seeMoreJobPostings/search"
        f"?keywords={kw}&location=India&f_JT=I&start={start}"
    )


def _fetch_one_domain(page, keyword: str, limit: int) -> list[dict]:
    """Scrape job cards for a single keyword via LinkedIn's public guest jobs
    API (no login/authwall). The endpoint returns <li> base-card HTML, 25 per
    request; paginate with &start. Replaces the old /jobs/search app-page scrape,
    which authwalled anonymous sessions and returned nothing."""
    jobs: list[dict] = []
    seen: set[str] = set()
    try:
        for start in range(0, 75, 25):  # up to 3 pages (75 cards)
            if len(jobs) >= limit:
                break
            page.goto(_search_url(keyword, start), wait_until="domcontentloaded", timeout=45000)
            _rand_delay(page, 1.8, 3.2)
            cards = page.query_selector_all("li div.base-card, div.base-search-card, div.base-card")
            if not cards:
                break
            new_this = 0
            for card in cards:
                if len(jobs) >= limit:
                    break
                try:
                    title = _text(card, [".base-search-card__title", "h3"])
                    company = _text(card, [".base-search-card__subtitle", "h4"])
                    location = _text(card, [".job-search-card__location"])
                    urn = card.get_attribute("data-entity-urn") or ""
                    m = re.search(r"(\d{6,})", urn)
                    href = _attr(card, ["a.base-card__full-link", "a[href*='/jobs/view/']", "a"], "href") or ""
                    if m:
                        job_id = m.group(1)
                    else:
                        hm = re.search(r"-(\d{6,})(?:\?|/|$)", href)
                        job_id = hm.group(1) if hm else ""
                    if not title or not job_id or job_id in seen:
                        continue
                    seen.add(job_id)
                    url = href.split("?")[0] if href else f"{BASE}/jobs/view/{job_id}"
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
                    new_this += 1
                except Exception:  # noqa: BLE001
                    continue
            if new_this == 0:
                break
    except Exception:  # noqa: BLE001
        pass
    return jobs


def fetch(domains: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    """Fetch across all domains, deduplicated by external_id."""
    page = _context(uid).new_page()
    all_jobs: list[dict] = []
    seen_ids: set[str] = set()

    keywords = domains[:4] if domains else ["software development"]
    per_kw = max(5, (limit + len(keywords) - 1) // len(keywords))

    try:
        for kw in keywords:
            if len(all_jobs) >= limit:
                break
            jobs = _fetch_one_domain(page, kw, per_kw)
            for job in jobs:
                eid = job["external_id"]
                if eid and eid not in seen_ids:
                    seen_ids.add(eid)
                    all_jobs.append(job)
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass

    return all_jobs[:limit]


def apply(job: dict, cover_letter: str, uid: str = "",
          profile: dict | None = None, resume_path: str | None = None,
          record: dict | None = None) -> tuple[str, str]:
    # `record` is an optional out-parameter shared by every platform adapter (see
    # internshala.apply). This adapter does not populate it yet; accepting it keeps
    # the call shape uniform so the worker can pass it to all five without a branch.

    """Submit via LinkedIn Easy Apply. Reads phone/GPA from profile if provided."""
    manual_final_submit, hold_reason = safety.requires_manual_final_submit("linkedin")
    if manual_final_submit:
        return "needs_review", hold_reason
    phone = (profile or {}).get("phone") or ""
    gpa = str((profile or {}).get("gpa") or "8.0")

    page = _context(uid).new_page()
    try:
        page.goto(job["url"], wait_until="domcontentloaded", timeout=45000)
        _rand_delay(page, 2.5, 4.0)

        if safety.detect_challenge(page):
            safety.screenshot(page, uid, f"captcha_li_{job.get('external_id','')}")
            return "failed", "captcha challenge on LinkedIn"

        if _is_logged_out(page):
            return "login_required", "not signed in to LinkedIn — reconnect in the Integrations tab"

        already = page.query_selector(
            ":text('Applied'), [aria-label*='Applied'], .jobs-apply-button--applied"
        )
        if already:
            return "skipped", "already applied on LinkedIn"

        btn = selector_ai.find_element(page, "Easy Apply button or Apply button", [
            ".jobs-apply-button--top-card",
            "button.jobs-apply-button",
            "button:has-text('Easy Apply')",
            "button:has-text('Apply')",
        ])
        if not btn:
            return "skipped", "no LinkedIn Easy Apply button (external application)"
        _safe_click(btn, page)
        _rand_delay(page, 2.0, 3.5)

        # LinkedIn Easy Apply multi-step modal
        for step in range(8):
            if resume_path and os.path.isfile(resume_path):
                file_inp = _qsel(page, [
                    "input[type='file'][accept*='pdf']",
                    "input[type='file']",
                ])
                if file_inp:
                    try:
                        file_inp.set_input_files(resume_path)
                        _rand_delay(page, 0.5, 1.0)
                    except Exception:  # noqa: BLE001
                        pass

            for ta in page.query_selector_all("textarea"):
                try:
                    if not ta.input_value() and ta.is_visible():
                        ta.click()
                        _rand_delay(page, 0.3, 0.7)
                        ta.fill(cover_letter[:2000])
                except Exception:  # noqa: BLE001
                    pass

            for inp in page.query_selector_all(
                "input[type='text']:visible, input[type='number']:visible, input[type='tel']:visible"
            ):
                try:
                    val = inp.input_value()
                    if val:
                        continue
                    label = (inp.get_attribute("aria-label") or "").lower()
                    placeholder = (inp.get_attribute("placeholder") or "").lower()
                    hint = label + " " + placeholder
                    inp.click()
                    _rand_delay(page, 0.2, 0.5)
                    if "phone" in hint or "mobile" in hint:
                        if not phone:
                            return "skipped", "complex LinkedIn application needs a phone number not present in the profile"
                        inp.fill(str(phone))
                    elif "year" in hint or "experience" in hint:
                        inp.fill("0")
                    elif "cgpa" in hint or "gpa" in hint:
                        inp.fill(gpa)
                    elif inp.get_attribute("required") is not None or inp.get_attribute("aria-required") == "true":
                        return "skipped", "complex LinkedIn application has an unsupported required question"
                except Exception:  # noqa: BLE001
                    pass

            for radio_group in page.query_selector_all("fieldset:has(input[type='radio'])"):
                try:
                    first = radio_group.query_selector("input[type='radio']")
                    if first and not first.is_checked():
                        return "skipped", "complex LinkedIn application has a required choice question"
                except Exception:  # noqa: BLE001
                    pass

            for sel in page.query_selector_all("select:visible"):
                try:
                    if not sel.input_value():
                        return "skipped", "complex LinkedIn application has a required selection question"
                except Exception:  # noqa: BLE001
                    pass

            _rand_delay(page, 0.5, 1.2)
            next_btn = selector_ai.find_element(
                page,
                "Submit application, Review, or Next button in Easy Apply modal",
                [
                    "button:has-text('Submit application')",
                    "button:has-text('Review')",
                    "button:has-text('Next')",
                    "button[aria-label='Submit application']",
                    "button[aria-label='Review your application']",
                ],
            )
            if not next_btn:
                break
            label = (next_btn.inner_text() or "").lower()
            _safe_click(next_btn, page)
            _rand_delay(page, 1.2, 2.5)
            if "submit" in label:
                _rand_delay(page, 1.5, 2.5)
                return "applied", "submitted via LinkedIn Easy Apply"

        return safety.classify_submit(page, [
            ":text('Application submitted')", ":text('application was sent')",
        ])
    except Exception as e:  # noqa: BLE001
        try:
            safety.screenshot(page, uid, f"exception_li_{job.get('external_id','')}")
        except Exception:  # noqa: BLE001
            pass
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
    # Return [] — not ["communication"] — when nothing matches. A placeholder skill
    # reads to matcher.score_job as a real requirement the candidate misses, dragging
    # every unrecognised title down to a near-zero role-skill score. [] means
    # "requirements unknown" and scores on relevance instead. (Same fix as internshala.)
    low = (title or "").lower()
    out: list[str] = []
    for k, v in _SKILL_HINTS.items():
        if k in low:
            for s in v:
                if s not in out:
                    out.append(s)
    return out
