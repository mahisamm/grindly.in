"""Open a real browser so the user logs into Internshala ONCE. The session is
saved in the shared persistent profile (browser_profile/) that internshala.py
reuses, so the agent can apply for real afterwards.

Flow:
  1. Launch headed Chromium on the persistent profile.
  2. Navigate to the Internshala login page.
  3. Poll until the account is logged in (or timeout).
  4. Mark users.internshala_connected = 1 for the uid and exit.

Usage: python connect_internshala.py --user <uid> [--timeout 300]
"""
from __future__ import annotations
import argparse
import sys
import os
import time

sys.path.insert(0, os.path.dirname(__file__))
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import db
from internshala import PROFILE_DIR, BASE


def _logged_in(page) -> bool:
    """Internshala shows the student dashboard / profile menu when signed in."""
    try:
        html = page.content().lower()
    except Exception:  # noqa: BLE001
        return False
    if "logout" in html or "/student/dashboard" in html or "your applications" in html:
        return True
    # the profile dropdown only renders for authed users
    return bool(page.query_selector("#name_box, .profile_container, .training_user_dropdown"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--user", required=True)
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    os.makedirs(PROFILE_DIR, exist_ok=True)
    print(f"[connect] launching browser for {args.user} — log into Internshala in the window")
    with sync_playwright() as pw:
        ctx = pw.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,  # must be visible so the user can log in
            args=["--disable-blink-features=AutomationControlled"],
            viewport={"width": 1200, "height": 860},
        )
        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        try:
            page.goto(f"{BASE}/login/student", wait_until="domcontentloaded", timeout=45000)
        except Exception:  # noqa: BLE001
            page.goto(BASE, wait_until="domcontentloaded", timeout=45000)

        deadline = time.time() + args.timeout
        connected = False
        while time.time() < deadline:
            if _logged_in(page):
                connected = True
                break
            time.sleep(2)

        if connected:
            db.set_internshala_connected(args.user, True)
            print("[connect] logged in — session saved. You can close the window.")
            # let the cookies flush to disk
            time.sleep(2)
        else:
            print("[connect] timed out waiting for login.")
        try:
            ctx.close()
        except Exception:  # noqa: BLE001
            pass

    sys.exit(0 if connected else 1)


if __name__ == "__main__":
    main()
