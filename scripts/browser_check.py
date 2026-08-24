#!/usr/bin/env python
"""The two things about a page that only a browser can tell you.

LAYOUT: does anything fall off the side of the screen?
ACCESSIBILITY: does axe-core object to anything at serious severity or worse?

This exists because of a bug that nothing else could have caught. Every page's
outer container is a flex item centred with `mx-auto`, and a flex item with an
auto cross-axis margin is sized to fit-content rather than stretched to the
line. /admin holds two tables, so on a 412px phone its container laid out at
600px, `overflow-x: clip` on <body> hid the surplus, and the Approve buttons in
the beta access queue sat off the right edge with no way to scroll to them.

Every signal said the page was fine. `document.scrollWidth` read 412, because
the overflow was CLIPPED rather than scrolled. There was no console error. A
screenshot taken at the document's own width looks correct, which is how it
survived being looked at.

The only thing that finds it is comparing each element's right edge against
`window.innerWidth`, which is what this does — skipping anything inside a real
scroll container, because a wide table that scrolls horizontally is a design
decision rather than a bug.

The accessibility half needs `pip install axe-playwright-python` and skips
itself with a note when that is absent, so this stays runnable on a box
carrying only what the renderer needs. It found three real defects the first
time it ran: a funnel percentage dimmed twice down to 3.03:1, /admin with no
main landmark, and the landing page's two unlabelled <nav> elements.

Usage:  python scripts/browser_check.py [base_url] [--cookie name=value]

With a cookie it also checks the signed-in pages, which is where the bug that
prompted this actually was — a public-pages-only sweep would have missed it
entirely. `npm run smoke` passes one from the throwaway admin it creates.

Requires the agent's Playwright install (pip install -r agent/requirements.txt).
"""
from __future__ import annotations

import sys

PUBLIC = ["/", "/login", "/signup", "/pricing", "/privacy", "/terms", "/forgot"]
SIGNED_IN = ["/app", "/app/settings", "/admin"]

# Right edge past the viewport, ignoring anything a scroll container owns.
PROBE = """() => {
  const vw = window.innerWidth;
  const scrolled = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if (ox === 'auto' || ox === 'scroll') return true;
    }
    return false;
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.getBoundingClientRect().right <= vw + 1) continue;
    // Purely decorative layers are intentionally allowed to extend beyond
    // their clipped canvas. Keep this narrow: real content hidden by an
    // overflow container must still fail this probe.
    if (el.closest('[aria-hidden="true"]')) continue;
    if (scrolled(el)) continue;
    out.push(el.tagName + '.' + (el.className || '').toString().slice(0, 40));
  }
  return { vw, escaping: out.slice(0, 5) };
}"""


def main() -> int:
    args = sys.argv[1:]
    cookie = ""
    if "--cookie" in args:
        at = args.index("--cookie")
        cookie = args[at + 1] if at + 1 < len(args) else ""
        del args[at:at + 2]
    base = (args[0] if args else "http://localhost:3000").rstrip("/")
    routes = PUBLIC + (SIGNED_IN if cookie else [])
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("layout_check: playwright is not installed — skipping", file=sys.stderr)
        return 0

    try:
        from axe_playwright_python.sync_playwright import Axe
        axe = Axe()
    except ImportError:
        axe = None
        print("note: axe-playwright-python not installed - a11y pass skipped")

    failures = 0
    with sync_playwright() as p:
        browser = p.chromium.launch()
        # A phone and a laptop. The phone is the one that finds things; the
        # laptop is there so a fix for the phone cannot quietly break the wide
        # layout it was meant to leave alone.
        for label, context_args in (
            ("412px", p.devices["Pixel 7"]),
            ("1440px", {"viewport": {"width": 1440, "height": 900}}),
        ):
            context = browser.new_context(**context_args)
            if cookie:
                name, _, value = cookie.partition("=")
                host = base.split("//", 1)[-1].split(":")[0].split("/")[0]
                context.add_cookies([{ "name": name, "value": value, "domain": host, "path": "/" }])
            page = context.new_page()
            for route in routes:
                try:
                    page.goto(base + route, wait_until="networkidle", timeout=30000)
                except Exception as exc:  # noqa: BLE001
                    print(f"FAIL  {label:7} {route:10} could not load — {exc}")
                    failures += 1
                    continue
                page.wait_for_timeout(300)
                result = page.evaluate(PROBE)
                escaping = result["escaping"]
                if escaping:
                    failures += 1
                    print(f"FAIL  {label:7} {route:10} escapes the viewport: {escaping}")
                else:
                    print(f"ok    {label:7} {route:10}")

                # Accessibility once per route, at the wide width only: axe
                # reports on the same DOM twice otherwise, and no rule in
                # the serious/critical set here is width-sensitive.
                if axe is not None and label == "1440px":
                    serious = [
                        v for v in axe.run(page).response["violations"]
                        if v["impact"] in ("serious", "critical")
                    ]
                    for v in serious:
                        failures += 1
                        where = v["nodes"][0]["target"][0][:70] if v["nodes"] else "?"
                        print(f"FAIL  a11y    {route:10} [{v['impact']}] {v['id']}: "
                              f"{v['help'][:60]} -> {where}")
            context.close()
        browser.close()

    print(f"\n{failures} layout or accessibility failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
