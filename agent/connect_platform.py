"""Generic platform connector: opens a headed browser so the user logs in ONCE.
Session saved in a persistent per-user per-platform profile directory.

Flow:
  1. Launch headed Chromium on the persistent profile.
  2. Navigate to the platform login URL.
  3. Poll until the account is detected as logged in (platform-specific check).
  4. Write user_integrations.status = 'connected' for this uid+platform.

Usage:
  python connect_platform.py --user <uid> --platform <platform> [--timeout 300]

Supported platforms: linkedin | internshala | naukri | unstop | indeed
"""
from __future__ import annotations
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import db
import stealth


def _internshala_logged_in(page) -> bool:
    # Imported lazily: connect_platform is also run on a dev box where importing
    # the whole apply driver (and its Playwright-heavy module graph) at startup
    # is a cost this file does not otherwise pay.
    import internshala

    return internshala.is_logged_in(page)


# Per-platform login entry URL and a logged-in predicate.
# The predicate returns True when the user is detected as authenticated.
_PLATFORMS: dict[str, dict] = {
    "internshala": {
        "login_url": "https://internshala.com/login/student",
        # The apply driver's own test, imported rather than reimplemented. Two
        # copies of "is this account signed in?" is how connect came to report a
        # saved session while every application reported none.
        "check": lambda page: _internshala_logged_in(page),
        # Where to re-ask the question once the browser is closed: a normal
        # listing page, which is what apply() actually opens.
        "verify_url": "https://internshala.com/internships/",
        "label": "Internshala",
    },
    "naukri": {
        "login_url": "https://www.naukri.com/nlogin/login",
        "check": lambda page: (
            "logout" in page.content().lower()
            or bool(page.query_selector(
                ".nI-gNb-header__account, .nI-gNb-header__usrName, [class*='user-name']"
            ))
        ),
        "label": "Naukri",
    },
    "unstop": {
        "login_url": "https://unstop.com/login",
        "check": lambda page: (
            bool(page.query_selector(
                ".user-info, .profile-pic, [class*='user-avatar'], "
                "[class*='userAvatar'], .un-avatar"
            ))
            or ("dashboard" in page.url or "profile" in page.url)
        ),
        "label": "Unstop",
    },
    "indeed": {
        "login_url": "https://secure.indeed.com/auth?hl=en_IN&co=IN",
        "check": lambda page: (
            "my jobs" in page.content().lower()
            or "my resume" in page.content().lower()
            or bool(page.query_selector("[data-gnav-element-name='UserAccountMenu'], .gnav-user"))
        ),
        "label": "Indeed",
    },
    "linkedin": {
        "login_url": "https://www.linkedin.com/login",
        "check": lambda page: (
            "feed" in page.url
            or bool(page.query_selector(".global-nav__me-photo, .nav-logo--minor"))
            or (
                "linkedin.com" in page.url
                and "login" not in page.url
                and "checkpoint" not in page.url
            )
        ),
        "label": "LinkedIn",
    },
}


def _profile_base() -> str:
    """Root dir holding per-user persistent browser profiles — must be a
    volume shared between the web app and every worker replica, or a session
    saved by one container is invisible to the next. See internshala.py's
    _profile_base() for the full rationale; override with GRINDLY_PROFILE_BASE."""
    env = os.environ.get("GRINDLY_PROFILE_BASE")
    if env:
        return env
    return os.path.join(os.path.dirname(__file__), "..", "data", "browser_profile")


def _profile_dir(uid: str, platform: str) -> str:
    # Must match linkedin.py/naukri.py/etc _profile_dir() exactly, or
    # connect_platform.py saves a login the apply-side driver will never find.
    return os.path.join(_profile_base(), uid, platform)


def connect(uid: str, platform: str, timeout: int = 300, display: str | None = None) -> bool:
    cfg = _PLATFORMS.get(platform)
    if not cfg:
        print(f"[connect] unknown platform: {platform}")
        return False

    from playwright.sync_api import sync_playwright

    profile = _profile_dir(uid, platform)
    os.makedirs(profile, exist_ok=True)
    stealth.clear_stale_lock(profile)
    # The identity this profile will keep for the rest of its life — the SAME one
    # every apply run presents afterwards. This used to be a hardcoded
    # "Chrome/124 on Windows" while the apply side drew a fresh user agent per
    # launch, so four logins in five were saved under a browser that never opened
    # them again and the platform dropped the session. See
    # stealth.profile_identity.
    ident = stealth.profile_identity(profile)

    print(
        f"[connect] launching browser for {uid} on {cfg['label']} — "
        f"log in in the browser window that opens"
    )
    connected = False
    with sync_playwright() as pw:
        launch_options = {}
        if display:
            launch_options["env"] = dict(os.environ, DISPLAY=display)
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=False,
            **launch_options,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-infobars",
                "--no-first-run",
                "--disable-dev-shm-usage",
            ],
            user_agent=ident["user_agent"],
            viewport=ident["viewport"],
        )
        # Same bot-detection mitigations the apply-side drivers use. Without
        # this the login page sees navigator.webdriver etc. and is more likely
        # to throw a captcha/"unusual activity" wall at the user mid-login.
        try:
            stealth.apply_stealth(ctx)
        except Exception:  # noqa: BLE001
            pass
        # Kill Google One-Tap / "Sign in with Google" in the remote browser.
        # Sites like LinkedIn auto-pop a Google Identity (gsi) prompt over their
        # own form; the user types their password into it, and Google rejects
        # every login from a server browser as "Wrong password" (anti-automation)
        # — a dead end that looks like the user's fault. Aborting the gsi
        # requests stops the prompt from ever appearing, so the user stays on the
        # platform's real email+password form, which does work here. Blocks only
        # the Google widget; nothing else on the login page depends on it.
        def _block_google_signin(route):  # noqa: ANN001
            try:
                route.abort()
            except Exception:  # noqa: BLE001
                pass
        for _pattern in (
            "https://accounts.google.com/gsi/**",
            "https://accounts.google.com/o/oauth2/**",
        ):
            try:
                ctx.route(_pattern, _block_google_signin)
            except Exception:  # noqa: BLE001
                pass
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(cfg["login_url"], wait_until="domcontentloaded", timeout=45000)
        except Exception:  # noqa: BLE001
            pass

        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if cfg["check"](page):
                    connected = True
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(2)

        if connected:
            print(
                f"[connect] {cfg['label']} login detected — checking that the "
                f"session survives a reload."
            )
            # A login the agent cannot reuse is not a connection.
            #
            # The old code wrote `connected` the instant the page looked signed
            # in and closed the browser. Everything that can go wrong AFTER that
            # moment — cookies that never flush, a session the platform binds to
            # a device and then drops, a "remember me" the user left unticked —
            # went unnoticed here and surfaced hours later as every application
            # failing with "not signed in", on an account the dashboard showed
            # as connected. Reload the page the apply driver actually opens and
            # ask again.
            connected = _survives_reload(page, cfg)
            if not connected:
                print(
                    f"[connect] {cfg['label']} session did not survive — "
                    f"not marking the account connected."
                )

        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass

    if connected:
        db.set_integration_status(uid, platform, "connected")
        # legacy Internshala column
        if platform == "internshala":
            db.set_internshala_connected(uid, True)
        print(
            f"[connect] {cfg['label']} login confirmed — session saved. "
            f"You can close the browser window."
        )
    else:
        db.set_integration_status(
            uid, platform, "needs_login",
            error=f"The {cfg['label']} login didn't stick — please try again.",
        )
        print(f"[connect] {cfg['label']} not connected.")

    return connected


def _survives_reload(page, cfg: dict) -> bool:
    """Re-ask the logged-in question on the page the apply driver opens.

    Not a formality: the platform decides whether a session is real, and it
    decides on the request AFTER the login, not during it.
    """
    url = cfg.get("verify_url")
    if not url:
        return True
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        page.wait_for_timeout(2500)
        return bool(cfg["check"](page))
    except Exception as e:  # noqa: BLE001
        print(f"[connect] could not verify the session: {e}")
        return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True, help="Grindly user id")
    ap.add_argument(
        "--platform",
        required=True,
        choices=list(_PLATFORMS.keys()),
        help="Platform to connect",
    )
    ap.add_argument("--timeout", type=int, default=300, help="Seconds to wait for login")
    args = ap.parse_args()

    ok = connect(args.user, args.platform, args.timeout)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
