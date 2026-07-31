"""Server-side credential login for hosted Grindly.

On a hosted VPS there is no screen to pop a browser onto, so the user cannot log
in by hand the way connect_platform.py (headed, local-only) assumes. Instead the
user submits their platform email + password in the dashboard; the web app stores
them AES-256-GCM encrypted (PlatformCredential) and enqueues a `connect_<platform>`
run. A worker picks it up and calls login() here:

  1. Decrypt the stored credentials.
  2. Launch a persistent browser context on the SHARED per-user profile dir
     (the same one internshala.apply() reuses) — headed inside Xvfb in prod for
     the best anti-bot posture, headless if no display.
  3. Type the credentials like a human and submit.
  4. Resolve the outcome:
       - logged in            -> integration status 'connected'
       - one-time code needed -> status 'otp_required', then poll the DB for the
                                 code the user posts from the dashboard, enter it,
                                 and continue (OTP relay).
       - captcha / bad creds  -> status 'needs_login' with a human error string.
  5. Close the context so cookies flush to disk for the apply driver to reuse.

Usage (normally invoked via worker.run_job, not directly):
  python connect_login.py --user <uid> --platform internshala
"""
from __future__ import annotations
import argparse
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import db
import safety
import secret_box
import stealth
import internshala as internshala_mod

# How long to wait for the user to submit a one-time code before giving up.
OTP_WAIT_SEC = int(os.environ.get("GRINDLY_OTP_WAIT_SEC", "180"))

# Per-platform login config. Each entry knows its login URL, how to fill the
# form, and how to tell logged-in / otp-gate / bad-credentials apart.
_LOGIN_URL = {
    "internshala": "https://internshala.com/login/student",
}

_EMAIL_SELECTORS = ["#email", "input[name='email']", "input[type='email']"]
_PASSWORD_SELECTORS = ["#password", "input[name='password']", "input[type='password']"]
_SUBMIT_SELECTORS = [
    "#login_submit",
    "button[type='submit']",
    "input[type='submit']",
    "button:has-text('Login')",
]


def _first(page, selectors):
    for s in selectors:
        try:
            el = page.query_selector(s)
            if el and el.is_visible():
                return el
        except Exception:  # noqa: BLE001
            continue
    return None


def _human_type(page, el, text: str) -> None:
    try:
        el.scroll_into_view_if_needed()
        page.wait_for_timeout(random.randint(150, 400))
        el.click()
        page.wait_for_timeout(random.randint(150, 350))
        for ch in text:
            page.keyboard.type(ch)
            page.wait_for_timeout(random.randint(40, 160))
    except Exception:  # noqa: BLE001
        try:
            el.fill(text)
        except Exception:  # noqa: BLE001
            pass


def _logged_in(page) -> bool:
    try:
        html = page.content().lower()
    except Exception:  # noqa: BLE001
        return False
    if "/student/dashboard" in page.url:
        return True
    if "logout" in html or "your applications" in html or "student/dashboard" in html:
        return True
    return bool(page.query_selector("#name_box, .profile_container, .training_user_dropdown"))


def _survives_reload(page) -> bool:
    """Does the apply driver agree the account is signed in?

    `_logged_in` reads the page we happen to be standing on right after a submit.
    What matters is the page apply() opens, asked with apply()'s own test — the
    two answered differently in production, and the dashboard believed the
    optimistic one for three days.
    """
    import internshala as _internshala

    try:
        page.goto("https://internshala.com/internships/",
                  wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2500)
        return _internshala.is_logged_in(page)
    except Exception as e:  # noqa: BLE001
        print(f"[connect_login] could not verify the session: {e}")
        return False


def _otp_gate(page) -> bool:
    """True when the page is asking for an emailed/SMS one-time code."""
    try:
        html = page.content().lower()
    except Exception:  # noqa: BLE001
        return False
    keywords = ("otp", "one time password", "one-time password",
                "verification code", "verify your", "enter the code", "verify it's you")
    if any(k in html for k in keywords):
        # must also expose an input to type the code into
        return bool(_first(page, [
            "input[name*='otp' i]", "input[id*='otp' i]",
            "input[autocomplete='one-time-code']",
            "input[type='tel']", "input[type='number']",
        ]))
    return False


def _bad_credentials(page) -> str | None:
    try:
        html = page.content().lower()
    except Exception:  # noqa: BLE001
        return None
    for phrase in ("incorrect password", "invalid email or password",
                   "email or password is incorrect", "no account", "wrong password",
                   "incorrect email"):
        if phrase in html:
            return "Incorrect Internshala email or password."
    return None


def _submit_otp(page, code: str) -> None:
    inp = _first(page, [
        "input[name*='otp' i]", "input[id*='otp' i]",
        "input[autocomplete='one-time-code']",
        "input[type='tel']", "input[type='number']",
    ])
    if inp:
        _human_type(page, inp, code)
        page.wait_for_timeout(random.randint(300, 700))
        btn = _first(page, [
            "button:has-text('Verify')", "button:has-text('Submit')",
            "button[type='submit']", "input[type='submit']", "#login_submit",
        ])
        if btn:
            try:
                btn.click()
            except Exception:  # noqa: BLE001
                page.keyboard.press("Enter")
        else:
            page.keyboard.press("Enter")


def _wait_for_otp(uid: str, platform: str, page) -> str:
    """Relay loop: flag OTP needed, poll the DB until the user posts a code (or
    the gate clears on its own), then enter it. Returns final status string."""
    db.set_integration_otp_required(uid, platform)
    print(f"[connect_login] OTP gate for {uid}/{platform} — waiting up to {OTP_WAIT_SEC}s")
    deadline = time.time() + OTP_WAIT_SEC
    while time.time() < deadline:
        if _logged_in(page):
            return "connected"
        code = db.take_integration_otp(uid, platform)
        if code:
            print("[connect_login] received OTP — submitting")
            _submit_otp(page, code.strip())
            page.wait_for_timeout(3000)
            if _logged_in(page):
                return "connected"
            bad = _bad_credentials(page) or ("Wrong code." if _otp_gate(page) else None)
            if bad:
                db.set_integration_status(uid, platform, "needs_login", error=bad)
                return "failed"
        time.sleep(2)
    db.set_integration_status(uid, platform, "needs_login",
                              error="Timed out waiting for the one-time code.")
    return "timeout"


def login(uid: str, platform: str = "internshala", timeout: int = 90) -> dict:
    """Run the credential login. Writes integration status as it goes and returns
    {status, detail}."""
    url = _LOGIN_URL.get(platform)
    if not url:
        return {"status": "failed", "detail": f"unsupported platform: {platform}"}

    blob = db.get_platform_credential(uid, platform)
    if not blob:
        db.set_integration_status(uid, platform, "needs_login",
                                  error="No saved credentials — add them and retry.")
        return {"status": "failed", "detail": "no credentials on record"}
    try:
        creds = json.loads(secret_box.decrypt_secret(blob))
        email = creds.get("email", "").strip()
        password = creds.get("password", "")
    except Exception as e:  # noqa: BLE001
        db.set_integration_status(uid, platform, "needs_login",
                                  error="Stored credentials are unreadable — re-enter them.")
        return {"status": "failed", "detail": f"credential decrypt failed: {e}"}
    if not email or not password:
        db.set_integration_status(uid, platform, "needs_login",
                                  error="Saved credentials are incomplete — re-enter them.")
        return {"status": "failed", "detail": "empty credentials"}

    from playwright.sync_api import sync_playwright

    profile = internshala_mod._profile_dir(uid)
    os.makedirs(profile, exist_ok=True)
    stealth.clear_stale_lock(profile)
    # The identity every later apply run will present on this profile. Logging in
    # as one browser and applying as another is how a completed login came back
    # as "not signed in" — see stealth.profile_identity.
    ident = stealth.profile_identity(profile)
    headless = os.environ.get("INTERNPILOT_HEADLESS", "0") == "1"

    print(f"[connect_login] logging into {platform} for {uid} (headless={headless})")
    final = {"status": "failed", "detail": "unknown"}
    pw = sync_playwright().start()
    ctx = None
    try:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--no-first-run",
                "--disable-dev-shm-usage",
            ],
            viewport=ident["viewport"],
            user_agent=ident["user_agent"],
        )
        try:
            stealth.apply_stealth(ctx)
        except Exception:  # noqa: BLE001
            pass
        page = ctx.pages[0] if ctx.pages else ctx.new_page()

        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:  # noqa: BLE001
            final = {"status": "failed", "detail": f"could not load login page: {e}"}
            db.set_integration_status(uid, platform, "needs_login",
                                      error="Couldn't reach Internshala — try again shortly.")
            return final

        page.wait_for_timeout(random.randint(1200, 2600))

        # Already signed in from a prior session? Done.
        if _logged_in(page):
            db.set_integration_status(uid, platform, "connected")
            return {"status": "connected", "detail": "already signed in"}

        challenge = safety.detect_challenge(page)
        if challenge:
            db.set_integration_status(uid, platform, "needs_login",
                                      error="Internshala showed a captcha — can't log in automatically right now.")
            return {"status": "failed", "detail": f"captcha: {challenge}"}

        email_el = _first(page, _EMAIL_SELECTORS)
        pass_el = _first(page, _PASSWORD_SELECTORS)
        if not email_el or not pass_el:
            db.set_integration_status(uid, platform, "needs_login",
                                      error="Internshala's login form changed — we're on it.")
            return {"status": "failed", "detail": "login form fields not found"}

        _human_type(page, email_el, email)
        page.wait_for_timeout(random.randint(250, 600))
        _human_type(page, pass_el, password)
        page.wait_for_timeout(random.randint(300, 700))

        submit = _first(page, _SUBMIT_SELECTORS)
        if submit:
            try:
                submit.click()
            except Exception:  # noqa: BLE001
                page.keyboard.press("Enter")
        else:
            page.keyboard.press("Enter")

        # Let the result settle.
        for _ in range(10):
            page.wait_for_timeout(1000)
            if _logged_in(page) or _otp_gate(page) or _bad_credentials(page):
                break

        if _logged_in(page):
            if _survives_reload(page):
                db.set_integration_status(uid, platform, "connected")
                final = {"status": "connected", "detail": "logged in"}
            else:
                db.set_integration_status(
                    uid, platform, "needs_login",
                    error="The login didn't stick — please try again.")
                final = {"status": "failed", "detail": "session did not survive a reload"}
        elif _bad_credentials(page):
            msg = _bad_credentials(page)
            db.set_integration_status(uid, platform, "needs_login", error=msg)
            final = {"status": "failed", "detail": msg}
        elif safety.detect_challenge(page):
            db.set_integration_status(uid, platform, "needs_login",
                                      error="Internshala showed a captcha after login — try again later.")
            final = {"status": "failed", "detail": "captcha after submit"}
        elif _otp_gate(page):
            status = _wait_for_otp(uid, platform, page)
            if status == "connected" and not _survives_reload(page):
                db.set_integration_status(
                    uid, platform, "needs_login",
                    error="The login didn't stick — please try again.")
                final = {"status": "failed", "detail": "session did not survive a reload"}
            elif status == "connected":
                db.set_integration_status(uid, platform, "connected")
                final = {"status": "connected", "detail": "logged in via OTP"}
            else:
                final = {"status": status, "detail": "otp not completed"}
        else:
            # No clear signal — give the session the benefit of the doubt only if a
            # post-login marker exists, else flag for retry.
            if _logged_in(page):
                db.set_integration_status(uid, platform, "connected")
                final = {"status": "connected", "detail": "logged in (late)"}
            else:
                db.set_integration_status(uid, platform, "needs_login",
                                          error="Login didn't complete — check your credentials and retry.")
                final = {"status": "failed", "detail": "no login confirmation"}

        # Give cookies a moment to flush to the persistent profile.
        page.wait_for_timeout(2000)
        return final
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        db.set_integration_status(uid, platform, "needs_login",
                                  error="Login failed unexpectedly — please retry.")
        return {"status": "failed", "detail": f"exception: {str(e)[:160]}"}
    finally:
        try:
            if ctx:
                ctx.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            pw.stop()
        except Exception:  # noqa: BLE001
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--platform", default="internshala")
    args = ap.parse_args()
    out = login(args.user, args.platform)
    print(f"[connect_login] result: {out}")
    sys.exit(0 if out.get("status") == "connected" else 1)


if __name__ == "__main__":
    main()
