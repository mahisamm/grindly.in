"""Is the saved browser session actually logged in? — read-only.

`connect` reported "Internshala login detected — session saved" twice, and every
application the worker tried afterwards came back `session_expired`: "not signed
in to Internshala". Both cannot be true. Either the session is not reaching the
worker's profile directory, or the worker's own logged-out test is wrong about a
page that is fine.

This opens the platform with the SAME persistent profile the adapter uses and
prints the evidence for both readings side by side: what the adapter's test
says, and what the page itself shows (the account menu, the sign-in links, the
cookie names). Nothing is clicked, nothing is submitted, nothing is written.

    python session_probe.py --email you@example.com [--url https://...]
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db

# A listing page rather than the home page: the home page is the same for
# everyone, while the adapter's test runs on a listing, which is where it
# actually decides.
_DEFAULT_URL = "https://internshala.com/internships/"


def probe(uid: str, url: str) -> dict:
    import internshala

    out: dict = {"url": url, "profile_dir": internshala._profile_dir(uid)}
    page = internshala._context(uid).new_page()
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=40000)
        page.wait_for_timeout(2500)

        out["landed"] = page.url
        out["title"] = (page.title() or "")[:120]
        out["adapter_says_logged_out"] = internshala._is_logged_out(page)

        html = (page.content() or "").lower()
        out["html_len"] = len(html)
        # The three terms the adapter's test is built on, counted rather than
        # merely present — "login" appearing 40 times in analytics payloads is a
        # very different fact from a sign-in button.
        out["word_login"] = html.count("login")
        out["word_register"] = html.count("register")
        out["word_logout"] = html.count("logout")

        # What the adapter's second clause actually matched, quoted.
        out["visible_login_links"] = page.evaluate(
            """() => Array.from(document.querySelectorAll("a[href*='login']"))
                 .filter(a => a.offsetParent !== null)
                 .slice(0, 6)
                 .map(a => ((a.innerText || '').trim().replace(/\\s+/g,' ').slice(0,40))
                            + ' -> ' + (a.getAttribute('href') || '').slice(0, 80))"""
        )

        # Signals that only exist for a signed-in account.
        out["logged_in_markers"] = page.evaluate(
            """() => {
                 const hits = [];
                 const sel = [
                   "a[href*='/logout']", "a[href*='sign_out']",
                   "#name_container", ".profile_container", "#profile_container",
                   "a[href*='/student/dashboard']", "a[href*='/my-applications']",
                   "[class*='user_name' i]", "[class*='profile_name' i]",
                   "img[class*='avatar' i]"
                 ];
                 sel.forEach(s => { if (document.querySelector(s)) hits.push(s); });
                 return hits;
               }"""
        )

        # Cookie NAMES only — never values. A session cookie's presence answers
        # "did the login survive the handoff"; its contents are the user's
        # credentials and are nobody's business, including this file's.
        try:
            out["cookie_names"] = sorted({
                c["name"] for c in page.context.cookies()
                if "internshala" in (c.get("domain") or "")
            })[:40]
        except Exception:  # noqa: BLE001
            out["cookie_names"] = []
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"[:300]
    finally:
        try:
            page.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            internshala.close(uid)
        except Exception:  # noqa: BLE001
            pass
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--email", required=True)
    ap.add_argument("--url", default=_DEFAULT_URL)
    args = ap.parse_args()

    with db.conn() as c:
        row = c.execute(
            "SELECT id FROM users WHERE lower(email)=lower(?)", (args.email,)
        ).fetchone()
    if not row:
        raise SystemExit(f"no user {args.email}")
    uid = dict(row)["id"]

    rep = probe(uid, args.url)
    print(f"profile dir      : {rep.get('profile_dir')}")
    print(f"landed on        : {rep.get('landed')}")
    print(f"page title       : {rep.get('title')!r}")
    print(f"error            : {rep.get('error') or '-'}")
    print(f"ADAPTER VERDICT  : logged_out={rep.get('adapter_says_logged_out')}")
    print(f"  word counts    : login={rep.get('word_login')} "
          f"register={rep.get('word_register')} logout={rep.get('word_logout')} "
          f"(html {rep.get('html_len')} chars)")
    for link in rep.get("visible_login_links") or []:
        print(f"  visible login link: {link}")
    print(f"LOGGED-IN MARKERS: {rep.get('logged_in_markers') or 'none'}")
    print(f"cookies (names)  : {', '.join(rep.get('cookie_names') or []) or 'none'}")


if __name__ == "__main__":
    main()
