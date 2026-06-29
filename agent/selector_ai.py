"""AI-powered selector fallback for Playwright.

When hardcoded CSS selectors all fail, sends a stripped snapshot of the page
body to the LLM and asks it to identify the element. This keeps the agent
working through routine site DOM refactors without manual selector maintenance.
"""
from __future__ import annotations
import re

import llm as llm_mod

_MAX_HTML = 6000  # characters to send — stay cheap


def _compress_html(html: str) -> str:
    """Strip scripts/styles/SVGs and data-* noise; keep structure + text + id/class."""
    html = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.S | re.I)
    html = re.sub(r"<style[^>]*>.*?</style>",  "", html, flags=re.S | re.I)
    html = re.sub(r"<svg[^>]*>.*?</svg>", "<svg/>", html, flags=re.S | re.I)
    html = re.sub(r'\s+data-[a-z][a-z0-9-]*="[^"]*"', "", html)
    return html[:_MAX_HTML]


def find_element(page, description: str, selectors: list[str]):
    """Try CSS selectors first; ask LLM if all fail.

    Returns a Playwright element handle or None.
    Critical-path only (apply/submit buttons) — not for bulk card scraping.
    """
    # 1. fast path: known selectors
    for s in selectors:
        try:
            el = page.query_selector(s)
            if el:
                return el
        except Exception:
            continue

    # 2. AI fallback
    try:
        raw_html = page.inner_html("body")
        compressed = _compress_html(raw_html)

        prompt = (
            f"You are helping a browser automation script find a UI element.\n"
            f"Return ONLY a valid CSS selector, one line, no explanation, for: {description}\n\n"
            f"HTML (may be truncated):\n{compressed}"
        )
        response = llm_mod.chat(prompt, timeout=20)
        if not response:
            return None

        candidate = next(
            (
                line.strip().strip("\"'`")
                for line in response.splitlines()
                if line.strip() and not line.strip().startswith("#")
            ),
            None,
        )
        if not candidate:
            return None

        try:
            el = page.query_selector(candidate)
            if el:
                print(f"[selector_ai] AI found '{description}': {candidate}")
                return el
        except Exception:
            pass

    except Exception as e:
        print(f"[selector_ai] AI fallback error for '{description}': {e}")

    return None
