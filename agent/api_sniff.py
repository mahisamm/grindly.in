"""Find the JSON endpoint behind an ATS careers page.

Every board adapter in atsboards.py reads a vendor's own JSON API rather than
its HTML, because the HTML is a single-page-app shell — 1KB of <div id="root">
and a marketing nav, with the postings arriving later over XHR. Guessing that
endpoint from the outside costs a morning per vendor and usually ends in 404s.

So: load the page in a real browser, watch every response it makes, and print
the ones that came back as JSON. Whatever carries the postings IS the endpoint,
and the URL shape it prints is what goes in _API.

Read-only. Loads a public careers page, submits nothing, stores nothing.

    python api_sniff.py https://acme.keka.com/careers/ [https://... ...]
"""
from __future__ import annotations

import sys

# Noise every page makes: analytics, fonts, session pings. None of them carry
# job postings, and left in they bury the two responses that matter.
_BORING = (
    "google-analytics", "googletagmanager", "doubleclick", "hotjar", "segment",
    "sentry", "clarity.ms", "facebook", "linkedin.com/px", "gstatic",
    "cloudflareinsights", "intercom", "mixpanel", "fullstory", "/ping",
)


def _interesting(url: str) -> bool:
    return not any(b in url.lower() for b in _BORING)


def sniff(url: str, wait_ms: int = 9000) -> list[dict]:
    from playwright.sync_api import sync_playwright

    seen: list[dict] = []
    pw = sync_playwright().start()
    browser = None
    try:
        browser = pw.chromium.launch(headless=False, args=["--no-sandbox"])
        page = browser.new_page()

        def on_response(resp):
            try:
                ctype = (resp.headers or {}).get("content-type", "")
                if "json" not in ctype.lower() or not _interesting(resp.url):
                    return
                body = resp.body()
                seen.append({
                    "url": resp.url,
                    "status": resp.status,
                    "bytes": len(body or b""),
                    "method": resp.request.method,
                    "head": (body or b"")[:220].decode("utf-8", "replace"),
                })
            except Exception:  # noqa: BLE001
                # A response whose body is gone (redirect, preflight) tells us
                # nothing; it must not stop the rest of the capture.
                pass

        page.on("response", on_response)
        page.goto(url, timeout=45000, wait_until="domcontentloaded")
        try:
            page.wait_for_load_state("networkidle", timeout=20000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(wait_ms)
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        pw.stop()
    return seen


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    for url in sys.argv[1:]:
        print(f"\n=== {url}")
        try:
            found = sniff(url)
        except Exception as e:  # noqa: BLE001
            print(f"    failed: {type(e).__name__}: {e}")
            continue
        if not found:
            print("    no JSON responses — the postings are in the HTML, or behind a click")
        # Biggest first: the postings payload is nearly always the largest JSON
        # a careers page fetches, and the config/feature-flag calls are tiny.
        for r in sorted(found, key=lambda x: -x["bytes"])[:8]:
            print(f"    {r['status']} {r['method']:4} {r['bytes']:>8}b  {r['url'][:130]}")
            print(f"        {r['head'][:180]!r}")


if __name__ == "__main__":
    main()
