"""Fleet-level feature flags — the operational kill switches for autopilot.

One module, read everywhere, so "which switch turns this off?" always has one
answer. Every flag is an environment variable so an operator can flip it with a
container restart and NO code change, and every executor consults its flag at
dispatch time — so flipping one off strands no queue state, it just holds work.

Two layers of control exist and they are deliberately different:

  * These flags are FLEET-wide (an operator decision: "the ATS sender is
    misbehaving, kill it everywhere").
  * Per-user consent/readiness (profile.auto_apply, Phase 1 readiness) is a
    USER decision. A flag can never override a user's "no", and a user's "yes"
    means nothing while the fleet flag is off.

Defaults preserve current production behaviour: what runs today keeps running
(direct submit, daily report, all live sources); what does not exist yet ships
dark (browser executor, search discovery).
"""
from __future__ import annotations
import os


def _on(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


# ---- master ----------------------------------------------------------------

def autopilot_enabled() -> bool:
    """Master switch for every UNATTENDED submission path (server executors and
    browser tasks alike). Off = the agent still discovers, scores, plans and
    prepares — it just never sends anything by itself. Discovery staying on is
    deliberate: a paused fleet that keeps its queue warm can resume instantly."""
    return _on("GRINDLY_AUTOPILOT_ENABLED", True)


# ---- executors -------------------------------------------------------------

def direct_submit_enabled() -> bool:
    """Tier A server executors: Google Form, email, ATS. Off = those
    destinations are banked as matched instead of dispatched (channel_deliverable
    says no), exactly like a sender whose own enabled() is false."""
    return autopilot_enabled() and _on("GRINDLY_DIRECT_SUBMIT_ENABLED", True)


def browser_executor_enabled() -> bool:
    """The user's-own-browser task executor (extension autopilot). Ships dark
    until Phase 5 is proven on fixture pages."""
    return autopilot_enabled() and _on("GRINDLY_BROWSER_EXECUTOR_ENABLED", False)


# ---- discovery -------------------------------------------------------------

def search_discovery_enabled() -> bool:
    """Web-search source adapter. Dark until a search-provider key exists; the
    adapter itself also refuses to run without its key, so this is belt AND
    braces — turning the flag on with no key still discovers nothing."""
    return _on("GRINDLY_SEARCH_DISCOVERY_ENABLED", False)


def no_touch_only() -> bool:
    """Keep ONLY the listings the agent can finish by itself.

    On, discovery stops scraping the job boards and the run discards any match
    whose destination the agent may not submit unattended — so nothing reaches
    the dashboard that the user would have to finish by hand.

    The trade is real and is the point: board listings are the bulk of the raw
    volume, and every one of them ends at an account the user cannot afford to
    lose (LinkedIn, Naukri, Indeed, Unstop) or behind a login and a captcha
    (Internshala). A queue of work nobody can do is worse than a shorter queue,
    because each of those rows still spends a daily slot and still asks for a
    tap. Off (the default) keeps today's behaviour: find everything, submit what
    is safe, hand the rest over.
    """
    return _on("GRINDLY_NO_TOUCH_ONLY", False)


def source_enabled(source: str) -> bool:
    """Per-source kill switch: GRINDLY_SOURCE_<NAME>=0 drops one board from the
    rotation without touching the others. A failing adapter already degrades
    gracefully; this exists for the day a board must be turned off on PURPOSE
    (ToS letter, layout change mid-fix, rate-limit trouble)."""
    if not source:
        return False
    return _on(f"GRINDLY_SOURCE_{source.strip().upper()}", True)


# ---- reporting -------------------------------------------------------------

def daily_report_enabled() -> bool:
    """The end-of-run/daily user report. Off silences the report ONLY — runs,
    counts and dashboard state keep updating, so turning it back on loses
    nothing."""
    return _on("GRINDLY_DAILY_REPORT_ENABLED", True)


def snapshot() -> dict:
    """Every flag's current value — for the admin health surface and run logs,
    so 'why did nothing send?' is answerable from one line."""
    return {
        "autopilot": autopilot_enabled(),
        "direct_submit": direct_submit_enabled(),
        "browser_executor": browser_executor_enabled(),
        "search_discovery": search_discovery_enabled(),
        "daily_report": daily_report_enabled(),
        "no_touch_only": no_touch_only(),
    }
