"""Selector-drift detector — pages a human for *our* breakage, not the site's.

A live run fails for two very different reasons:

  * Transient / not-our-fault — the user's session expired, the platform threw a
    captcha, a listing closed, a request timed out. Retrying or asking the user
    to reconnect fixes these. Paging on-call for them is noise.

  * Selector drift — the platform changed its DOM and our selectors no longer
    match (`selector_missing` at volume). Nothing the user does fixes this; an
    engineer must update the adapter. THIS is what should page.

The existing per-run "HIGH FAILURE RATE" check treats every failure the same, so
a user who simply needs to re-login can trip the same alert as a genuine adapter
break. This module splits the signal: it alerts only when the *selector-missing*
share of attempts crosses a threshold on a large-enough sample.

Pure and deterministic — the worker feeds it per-source counts; tests feed it
fixtures. No I/O here.
"""
from __future__ import annotations

from dataclasses import dataclass

# Reason codes mirror agent/safety.py FAILURE_REASON.
SELECTOR_REASONS = frozenset({"selector_missing"})
# Site- or user-side conditions — deliberately excluded from the drift signal.
TRANSIENT_REASONS = frozenset(
    {"session_expired", "captcha", "listing_closed", "timeout", "firewall_blocked"}
)

MIN_ATTEMPTS = 5  # below this, one unlucky run isn't a trend worth paging on
SELECTOR_SHARE_ALERT = 0.5  # >=50% of attempts failing on selectors = drift


@dataclass(frozen=True)
class DriftReport:
    source: str
    attempts: int
    selector_failures: int
    selector_share: float
    alert: bool
    kind: str  # selector_drift | insufficient_sample | other_failures | healthy

    def message(self) -> str:
        if self.kind == "selector_drift":
            return (
                f":rotating_light: Selector drift on *{self.source}*: "
                f"{self.selector_failures}/{self.attempts} attempts "
                f"({int(self.selector_share * 100)}%) failed on missing selectors — "
                f"the site's DOM likely changed; the adapter needs updating."
            )
        if self.kind == "insufficient_sample":
            return (
                f"{self.source}: {self.attempts} attempts — too few to judge drift."
            )
        if self.kind == "other_failures":
            return (
                f"{self.source}: {self.attempts} attempts, "
                f"{self.selector_failures} selector-missing — below the drift threshold "
                f"(likely transient / user-side failures)."
            )
        return f"{self.source}: {self.attempts} attempts, no selector drift."


def assess_source(
    source: str,
    attempts: int,
    reasons: list[str] | None,
    *,
    min_attempts: int = MIN_ATTEMPTS,
    threshold: float = SELECTOR_SHARE_ALERT,
) -> DriftReport:
    """Classify one platform's run. `attempts` = applied + failed for the source;
    `reasons` = the failure-reason codes recorded among the failures."""
    reasons = reasons or []
    selector_failures = sum(1 for r in reasons if r in SELECTOR_REASONS)
    share = selector_failures / attempts if attempts else 0.0
    if attempts < min_attempts:
        return DriftReport(source, attempts, selector_failures, share, False, "insufficient_sample")
    if share >= threshold:
        return DriftReport(source, attempts, selector_failures, share, True, "selector_drift")
    kind = "other_failures" if selector_failures else "healthy"
    return DriftReport(source, attempts, selector_failures, share, False, kind)


def assess(
    stats: dict[str, dict],
    *,
    min_attempts: int = MIN_ATTEMPTS,
    threshold: float = SELECTOR_SHARE_ALERT,
) -> list[DriftReport]:
    """Assess every source. `stats[source] = {"attempts": int, "reasons": [...]}`.
    Returns reports sorted worst-first (alerting sources at the top)."""
    reports = [
        assess_source(
            src,
            data.get("attempts", 0),
            data.get("reasons"),
            min_attempts=min_attempts,
            threshold=threshold,
        )
        for src, data in stats.items()
    ]
    reports.sort(key=lambda r: (not r.alert, -r.selector_share))
    return reports
