"""Destination resolver — find where an application actually goes.

The reason this module exists
-----------------------------
Grindly's apply engine has always been complete: every platform adapter can log
in, fill a form, answer screening questions and click Submit. It has never been
allowed to, because `safety.requires_manual_final_submit()` fails closed for
every browser source. That was the right call: automating a submit on
Internshala / LinkedIn / Naukri / Indeed puts the *user's account* on the line,
and a banned account is worse than a slow job search.

But that risk is not a property of automation. It is a property of the
destination:

    ban risk requires a bannable account.

Most internship listings on those boards are cross-posts. The real application
lives on a Google Form, an HR mailbox, or an ATS portal (Greenhouse, Lever,
Ashby, Workable, SmartRecruiters, Zoho). None of those involve a user account at
all — they are public intake forms whose entire purpose is to receive
applications from strangers. Submitting there carries no ban risk because there
is nothing to ban.

So: keep discovery where the jobs are (the boards, read-only), and route the
*submission* to the employer's own front door whenever one can be found. This
module is the routing step. It reads a listing (its URL, its JD text, and
optionally the fetched HTML of the listing or the company's careers page) and
answers one question: where does this application really go, and is that
somewhere we may submit unattended?

What it deliberately does NOT do
--------------------------------
It does not decide policy — `safety.destination_policy()` does, from the tier
this returns. It does not fetch anything itself; the caller injects a fetcher so
this stays unit-testable and so page-load pacing remains the worker's business,
exactly like `matcher` and `scam` already work.
"""
from __future__ import annotations

import ipaddress
import re
from urllib.parse import urlparse

# ── Channels ────────────────────────────────────────────────────────────────
# How the application is physically delivered.
CHANNEL_GOOGLE_FORM = "google_form"   # POST to the form's own formResponse endpoint
CHANNEL_EMAIL = "email"               # send from the user's own Gmail, via OAuth
CHANNEL_ATS = "ats"                   # employer's applicant tracking system portal
CHANNEL_PLATFORM = "platform"         # no employer-side channel found; board only

# ── Tiers ───────────────────────────────────────────────────────────────────
# What we are allowed to do at that destination. See safety.destination_policy.
TIER_A = "A"   # no user account at stake  -> unattended submit is safe
TIER_B = "B"   # user's account, hosted    -> budgeted, explicit consent required
TIER_C = "C"   # user's account, hostile   -> never submitted from our servers

# ATS vendors whose public application pages require no candidate account.
# Value is the vendor slug we record on the application row, so coverage per
# vendor is measurable later (which is what decides where adapter work goes).
_ATS_HOSTS: dict[str, str] = {
    "boards.greenhouse.io": "greenhouse",
    "job-boards.greenhouse.io": "greenhouse",
    "jobs.lever.co": "lever",
    "jobs.ashbyhq.com": "ashby",
    "apply.workable.com": "workable",
    "jobs.workable.com": "workable",
    "jobs.smartrecruiters.com": "smartrecruiters",
    "careers.smartrecruiters.com": "smartrecruiters",
    "zohorecruit.com": "zoho",
    "recruit.zoho.in": "zoho",
    "freshteam.com": "freshteam",
    "keka.com": "keka",
    "darwinbox.in": "darwinbox",
}

_GOOGLE_FORM_RE = re.compile(
    r"https?://docs\.google\.com/forms/d/e/[A-Za-z0-9_-]+/viewform[^\s\"'<>)\]]*",
    re.I,
)
# The short /forms/d/<id>/ form (no /e/) is the *edit*-side id; its public
# viewform still resolves, so accept it too.
_GOOGLE_FORM_SHORT_RE = re.compile(
    r"https?://(?:docs\.google\.com/forms/d/|forms\.gle/)[A-Za-z0-9_-]+[^\s\"'<>)\]]*",
    re.I,
)

_URL_RE = re.compile(r"https?://[^\s\"'<>)\]]+", re.I)
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")

# Boards whose own domain never counts as an employer destination — a link back
# to the platform is the thing we are trying to route around.
_PLATFORM_DOMAINS = (
    "internshala.com", "linkedin.com", "naukri.com", "indeed.com", "indeed.co.in",
    "unstop.com", "dare2compete.com", "glassdoor.com", "monsterindia.com",
    "shine.com", "timesjobs.com", "foundit.in", "angel.co", "wellfound.com",
    "instahyre.com", "cutshort.io", "hirect.in", "apna.co",
)

# Mail domains that are never an employer intake address: the boards themselves,
# infra/noreply senders, and the free providers a scammer uses. A gmail.com
# "HR" address is the single most common signal of a fake internship posting, so
# routing an application there would be actively harmful — those listings should
# be caught by scam.py, and this is the second net under it.
_EMAIL_DENY_DOMAINS = _PLATFORM_DOMAINS + (
    "example.com", "example.org", "sentry.io", "google.com", "gstatic.com",
    "googleapis.com", "w3.org", "schema.org", "facebook.com", "twitter.com",
    "youtube.com", "wordpress.com", "sentry-cdn.com", "cloudflare.com",
)
_FREE_MAIL_DOMAINS = (
    "gmail.com", "yahoo.com", "yahoo.in", "outlook.com", "hotmail.com",
    "rediffmail.com", "proton.me", "protonmail.com", "icloud.com", "aol.com",
    "mail.com", "yandex.com", "zoho.com",
)
_EMAIL_DENY_LOCALPARTS = (
    "noreply", "no-reply", "donotreply", "do-not-reply", "postmaster", "abuse",
    "privacy", "legal", "unsubscribe", "notifications", "mailer-daemon",
)
# Local parts that positively indicate a hiring intake box.
_HIRING_LOCALPARTS = (
    "career", "careers", "hr", "jobs", "job", "hiring", "recruit", "recruitment",
    "recruiter", "talent", "internship", "interns", "intern", "apply",
    "applications", "resume", "cv", "people", "joinus", "join", "work",
)
# Words that must appear near an address for it to read as "send your CV here".
_APPLY_INTENT = re.compile(
    r"(send|mail|email|share|forward|drop|submit|write)\b[^.\n]{0,60}"
    r"\b(cv|resume|resumé|application|profile|portfolio)\b"
    r"|"
    r"\b(cv|resume|resumé|application)\b[^.\n]{0,60}\b(to|at)\b",
    re.I,
)
# Link text that means "the real form is over there".
_EXTERNAL_APPLY_HINT = re.compile(
    r"(apply\s+(on|at|via|through|here)|apply\s+now|application\s+(form|link)|"
    r"company\s+website|careers?\s+page|register\s+here|fill\s+(the|this)\s+form)",
    re.I,
)


def _host(url: str) -> str:
    """Hostname of a URL, lowercased, with a leading "www." removed.

    Not lstrip("www."): str.lstrip takes a SET OF CHARACTERS, not a prefix, so it
    eats every leading w and dot. "wellfound.com" became "ellfound.com" — which
    then failed to match the platform deny-list, and a Wellfound listing was
    treated as an employer's own intake. Same class of bug for any host starting
    with w (w3schools, workindia, wipro...).
    """
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""
    return host[4:] if host.startswith("www.") else host


def _is_platform_url(url: str) -> bool:
    h = _host(url)
    return any(h == d or h.endswith("." + d) for d in _PLATFORM_DOMAINS)


def is_fetchable(url: str) -> bool:
    """Is this URL safe for the agent to fetch?

    A job description is attacker-controlled text. Anyone who can post a listing
    can put a URL in it, and the agent follows "apply on the company website"
    links looking for a form — so without this, a listing saying

        Apply on the company website: http://169.254.169.254/latest/meta-data/
        Apply on the company website: http://postgres:5432/

    turns the worker into an SSRF probe against our own private network from
    inside the compose network, where nothing is firewalled from it.

    Allowed: http/https, to a public, dotted, non-IP-literal hostname. Everything
    else is refused. This is deliberately strict — the cost of a false negative is
    one unfollowed careers page; the cost of a false positive is an internal
    service reachable from a job posting.
    """
    try:
        parts = urlparse(url)
    except Exception:  # noqa: BLE001
        return False
    if parts.scheme not in ("http", "https"):
        return False
    host = (parts.hostname or "").lower()
    if not host:
        return False
    # Bare service names ("web", "postgres", "localhost") have no dot. A real
    # company careers page always does.
    if "." not in host:
        return False
    # An IP literal is never a legitimate careers page, and is the only way to
    # reach link-local / private ranges without controlling DNS.
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        return False
    if host.endswith(".local") or host.endswith(".internal") or host.endswith(".localhost"):
        return False
    return True


# Vendors that own their whole apex domain, matched by suffix rather than by
# listing every hostname they have ever used. Greenhouse alone serves postings
# from boards.greenhouse.io, job-boards.greenhouse.io and — for EU-hosted
# customers — job-boards.eu.greenhouse.io, which the exact-host map missed. Live,
# that graded four real Groww internships TIER_C ("never submitted from our
# servers") when they sit on the employer's own ATS with no account required.
_ATS_SUFFIXES: dict[str, str] = {
    "greenhouse.io": "greenhouse",
    "lever.co": "lever",
    "ashbyhq.com": "ashby",
}


def ats_vendor(url: str) -> str | None:
    """Vendor slug if `url` is a known ATS application page, else None."""
    h = _host(url)
    if not h:
        return None
    for host, vendor in _ATS_HOSTS.items():
        if h == host or h.endswith("." + host):
            return vendor
    for suffix, vendor in _ATS_SUFFIXES.items():
        if h == suffix or h.endswith("." + suffix):
            return vendor
    return None


def _google_form_url(text: str) -> str | None:
    for rx in (_GOOGLE_FORM_RE, _GOOGLE_FORM_SHORT_RE):
        m = rx.search(text or "")
        if m:
            return m.group(0).rstrip(".,);]'\"")
    return None


def _plausible_hiring_email(addr: str) -> bool:
    """Is this address an employer intake box rather than boilerplate?

    Free-mail addresses are rejected outright even when the local part looks
    like hiring ("hr.company@gmail.com"). A real company that accepts CVs by
    mail does it on its own domain; the gmail variant is the classic fake-
    internship pattern, and an application sent there hands a student's phone
    number and resume to whoever registered the address.
    """
    local, _, domain = addr.lower().partition("@")
    if not domain:
        return False
    if any(domain == d or domain.endswith("." + d) for d in _EMAIL_DENY_DOMAINS):
        return False
    if any(domain == d for d in _FREE_MAIL_DOMAINS):
        return False
    if any(local.startswith(p) for p in _EMAIL_DENY_LOCALPARTS):
        return False
    return True


def _hiring_email(text: str) -> tuple[str | None, str]:
    """Best employer intake address in `text`, with the evidence for picking it.

    Two ways in, strongest first: a hiring-shaped local part (careers@, hr@), or
    any company address sitting inside an explicit "send your resume to ..."
    sentence. Anything else is ignored — a random address in a page footer is
    not an application channel.
    """
    text = text or ""
    candidates = [a for a in _EMAIL_RE.findall(text) if _plausible_hiring_email(a)]
    if not candidates:
        return None, ""

    for addr in candidates:
        local = addr.lower().partition("@")[0]
        if any(local.startswith(p) or local == p for p in _HIRING_LOCALPARTS):
            return addr, f"hiring mailbox in listing text ({addr})"

    for addr in candidates:
        i = text.find(addr)
        window = text[max(0, i - 160): i + 60]
        if _APPLY_INTENT.search(window):
            return addr, f"listing says to send applications to {addr}"

    return None, ""


def _external_links(text: str) -> list[str]:
    """Off-platform, publicly-routable http(s) links in order, deduped.

    is_fetchable() is applied here rather than only at the fetch site so an
    internal address can never become a recorded application *destination*
    either — not just never be fetched.
    """
    seen: set[str] = set()
    out: list[str] = []
    for u in _URL_RE.findall(text or ""):
        u = u.rstrip(".,);]'\"")
        if u in seen or _is_platform_url(u) or not is_fetchable(u):
            continue
        seen.add(u)
        out.append(u)
    return out


def destination(
    *,
    channel: str,
    tier: str,
    target: str,
    vendor: str = "",
    evidence: str = "",
) -> dict:
    """One resolved destination. Plain dict so it round-trips through the DB and
    the worker without a schema change."""
    return {
        "channel": channel,
        "tier": tier,
        "target": target,
        "vendor": vendor,
        "evidence": evidence,
    }


def platform_destination(job: dict, tier: str) -> dict:
    """Fallback when no employer-side channel exists: the board itself."""
    src = job.get("source") or "platform"
    return destination(
        channel=CHANNEL_PLATFORM,
        tier=tier,
        target=job.get("url") or "",
        vendor=src,
        evidence="no employer-side application channel found in the listing",
    )


def platform_tier(source: str) -> str:
    """Risk tier of a board when we have to go through the board itself.

    Internshala is Tier B, not because it is friendlier, but because it is the
    one platform where the user has already handed us credentials through an
    explicit hosted-login consent flow — so a submit there is something they
    asked for, under a budget. The rest are Tier C: aggressive anti-automation
    plus an account the user cannot afford to lose. Anything unrecognised is
    treated as Tier C, so a new adapter never inherits permission by accident.
    """
    return TIER_B if (source or "").lower() == "internshala" else TIER_C


def resolve(
    job: dict,
    jd_text: str = "",
    *,
    fetch: "callable | None" = None,
    max_follow: int = 2,
) -> dict:
    """Where does this application actually go?

    `job`      listing dict (url, source, company, title)
    `jd_text`  the job description, if the caller already has it (it usually
               does — the worker scrapes JDs to re-score matches)
    `fetch`    optional `fetch(url) -> str` returning page HTML. Injected so this
               module never does I/O itself: the worker owns pacing and the
               tests own determinism. When None, resolution is text-only.
    `max_follow` how many off-platform links to open looking for a form/ATS.

    Returns a destination dict. Never raises — an unresolvable listing falls
    back to the platform channel, which is exactly today's behaviour.
    """
    url = job.get("url") or ""
    haystack = f"{url}\n{jd_text or ''}"

    # 1. The listing URL is already the real destination.
    vendor = ats_vendor(url)
    if vendor:
        return destination(
            channel=CHANNEL_ATS, tier=TIER_A, target=url, vendor=vendor,
            evidence=f"listing is a {vendor} application page",
        )
    if _google_form_url(url):
        return destination(
            channel=CHANNEL_GOOGLE_FORM, tier=TIER_A, target=url, vendor="google",
            evidence="listing is a Google Form",
        )

    # 2. The JD names one.
    form = _google_form_url(haystack)
    if form:
        return destination(
            channel=CHANNEL_GOOGLE_FORM, tier=TIER_A, target=form, vendor="google",
            evidence="Google Form linked in the job description",
        )
    for link in _external_links(haystack):
        v = ats_vendor(link)
        if v:
            return destination(
                channel=CHANNEL_ATS, tier=TIER_A, target=link, vendor=v,
                evidence=f"{v} link in the job description",
            )

    addr, why = _hiring_email(haystack)
    if addr:
        return destination(
            channel=CHANNEL_EMAIL, tier=TIER_A, target=addr, vendor="email",
            evidence=why,
        )

    # 3. Follow the listing's "apply on company website" links one hop.
    #    Bounded hard: this is the expensive branch, and an unbounded crawl of
    #    whatever a JD links to is both slow and a way to end up somewhere we
    #    had no business fetching.
    if fetch is not None:
        for link in _external_links(haystack)[:max_follow]:
            try:
                html = fetch(link) or ""
            except Exception:  # noqa: BLE001
                continue
            if not html:
                continue
            v = ats_vendor(link)
            if v:
                return destination(
                    channel=CHANNEL_ATS, tier=TIER_A, target=link, vendor=v,
                    evidence=f"{v} application page linked from the listing",
                )
            form = _google_form_url(html)
            if form:
                return destination(
                    channel=CHANNEL_GOOGLE_FORM, tier=TIER_A, target=form,
                    vendor="google",
                    evidence=f"Google Form on {_host(link)}",
                )
            for sub in _external_links(html):
                v = ats_vendor(sub)
                if v:
                    return destination(
                        channel=CHANNEL_ATS, tier=TIER_A, target=sub, vendor=v,
                        evidence=f"{v} application page on {_host(link)}",
                    )
            addr, why = _hiring_email(html)
            if addr:
                return destination(
                    channel=CHANNEL_EMAIL, tier=TIER_A, target=addr,
                    vendor="email", evidence=f"{why} (via {_host(link)})",
                )

    # 4. Nothing employer-side. Stay on the board, at the board's own risk tier.
    return platform_destination(job, platform_tier(job.get("source") or ""))


def looks_like_external_apply(jd_text: str) -> bool:
    """True when the JD tells the reader to apply somewhere else. Used only to
    decide whether following a link is worth a page load."""
    return bool(_EXTERNAL_APPLY_HINT.search(jd_text or ""))
