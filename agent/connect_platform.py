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

# Per-platform login entry URL and a logged-in predicate.
# The predicate returns True when the user is detected as authenticated.
_PLATFORMS: dict[str, dict] = {
    "internshala": {
        "login_url": "https://internshala.com/login/student",
        "check": lambda page: (
            "logout" in (page.content().lower())
            or bool(page.query_selector("#name_box, .profile_container, .training_user_dropdown"))
        ),
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


def _profile_dir(uid: str, platform: str) -> str:
    base = os.path.join(os.path.dirname(__file__), "browser_profile")
    return os.path.join(base, uid, platform)


def connect(uid: str, platform: str, timeout: int = 300) -> bool:
    cfg = _PLATFORMS.get(platform)
    if not cfg:
        print(f"[connect] unknown platform: {platform}")
        return False

    from playwright.sync_api import sync_playwright

    profile = _profile_dir(uid, platform)
    os.makedirs(profile, exist_ok=True)

    print(
        f"[connect] launching browser for {uid} on {cfg['label']} — "
        f"log in in the browser window that opens"
    )
    connected = False
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            profile,
            headless=False,
            args=["--disable-blink-features=AutomationControlled"],
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 860},
        )
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
            db.set_integration_status(uid, platform, "connected")
            # legacy Internshala column
            if platform == "internshala":
                db.set_internshala_connected(uid, True)
            print(
                f"[connect] {cfg['label']} login detected — session saved. "
                f"You can close the browser window."
            )
            time.sleep(2)
        else:
            print(f"[connect] timed out waiting for {cfg['label']} login.")

        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass

    return connected


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
