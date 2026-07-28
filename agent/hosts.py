"""What kind of place is this URL? One answer, shared by everything that asks.

Discovery had this knowledge spread across three modules and expressed only as a
denylist: `websearch._EXCLUDED_BRANDS` named ~50 brands to reject and everything
else was implicitly fine. A denylist cannot hold. New mirror domains appear
weekly — alexahire, vthetecheejobs, hellointern, jobgrid, internshiphub,
antaltechjobs, beincareer all sailed through a live run and outranked real
employers, because none of them had been written down yet.

Inverted here. A URL is trusted only when we can NAME why:

  ats        a posting on a vendor's applicant tracking system. The employer
             owns it, the candidate holds no account, and the vendor's JSON API
             proves the posting is real. This is the only tier the agent may
             submit unattended (resolver TIER_A).
  employer   the company's own site, on a careers-ish path. Also employer-owned,
             but nothing here proves a form exists, so it stays a rung below.
  board      LinkedIn, Naukri, Internshala and friends. Real listings, but
             applying needs the user's account there — each has its own adapter,
             and web discovery must not duplicate them.
  aggregator a site whose business is reprinting other people's listings. Owns
             no form. Following one spends the resolver's page budget to arrive
             back where we started.
  unknown    everything else. Kept — a small employer on a domain we have never
             seen is exactly the listing boards miss — but never trusted, never
             auto-applied, and ranked below anything we can vouch for.

`aggregator` is the only class still guessed rather than proven, and it guesses
from the SHAPE of the domain name: a second-level domain built out of job-board
words ("freshershunt", "internshiphub", "govtinternship") is a mirror far more
often than it is an employer. A real company caught by that lands in `unknown`,
which costs it ranking and the right to be auto-applied to — not its place in
the results.
"""
from __future__ import annotations

import re
import urllib.parse

# ---- applicant tracking systems --------------------------------------------
#
# Ordered most-specific first; `vendor_of` returns the first match. Every one of
# these publishes postings through a public JSON API, which is what makes a
# listing here provable rather than merely plausible.
_ATS_VENDORS: list[tuple[str, re.Pattern]] = [
    ("greenhouse", re.compile(r"(?:^|\.)(?:boards|job-boards|boards-api)(?:\.eu)?\.greenhouse\.io$|(?:^|\.)greenhouse\.io$", re.I)),
    ("lever", re.compile(r"(?:^|\.)lever\.co$", re.I)),
    ("ashby", re.compile(r"(?:^|\.)ashbyhq\.com$", re.I)),
    ("smartrecruiters", re.compile(r"(?:^|\.)smartrecruiters\.com$", re.I)),
    ("workday", re.compile(r"(?:^|\.)myworkdayjobs\.com$|(?:^|\.)myworkdaysite\.com$", re.I)),
    ("workable", re.compile(r"(?:^|\.)workable\.com$", re.I)),
    ("recruitee", re.compile(r"(?:^|\.)recruitee\.com$", re.I)),
    ("darwinbox", re.compile(r"(?:^|\.)darwinbox\.(?:in|com)$", re.I)),
    ("keka", re.compile(r"(?:^|\.)keka\.com$", re.I)),
    ("zohorecruit", re.compile(r"(?:^|\.)zohorecruit\.(?:com|in|eu)$", re.I)),
    ("freshteam", re.compile(r"(?:^|\.)freshteam\.com$", re.I)),
    ("teamtailor", re.compile(r"(?:^|\.)teamtailor\.com$", re.I)),
    ("jobvite", re.compile(r"(?:^|\.)jobvite\.com$", re.I)),
    ("icims", re.compile(r"(?:^|\.)icims\.com$", re.I)),
    ("successfactors", re.compile(r"(?:^|\.)successfactors\.(?:com|eu)$", re.I)),
    ("breezy", re.compile(r"(?:^|\.)breezy\.hr$", re.I)),
    ("bamboohr", re.compile(r"(?:^|\.)bamboohr\.com$", re.I)),
]

# Job boards. Either an adapter already owns them, or applying needs the user's
# own account there — which is never submitted from our servers.
_BOARD_BRANDS = {
    "linkedin", "indeed", "naukri", "unstop", "internshala", "glassdoor",
    "monster", "shine", "timesjobs", "simplyhired", "ziprecruiter", "jooble",
    "neuvoo", "foundit", "hirist", "cutshort", "instahyre", "apna", "wellfound",
    "angellist", "bayt", "iimjobs", "updazz", "jobhai", "workindia",
}

# Sites whose business is reprinting listings, plus the social/reference hosts
# that are never an application page. Named ones — the shape test below catches
# the rest.
_AGGREGATOR_BRANDS = {
    "myinternships", "internshipdunia", "letsintern", "twenty19", "jobsuche",
    "careerjet", "trovit", "adzuna", "talent", "jora", "whatjobs", "expertini",
    "careeralerts", "yohire", "prosple", "jobinsider", "talentd", "freshersworld",
    "fresherscamp", "jobsvacancy", "sarkariresult", "internshipwala", "placement",
    "offcampusjobs4u", "freshersvoice", "jobslibrary", "naukridaddy", "ambitionbox",
    "alexahire", "hellointern", "jobgrid", "internshiphub", "antaltechjobs",
    "beincareer", "vthetecheejobs", "freshershunt", "coursejoiner",
    "gethiredfaster", "govtinternship", "pminternshipscheme", "web3",
    "facebook", "twitter", "instagram", "reddit", "youtube", "quora",
    "pinterest", "medium", "wikipedia", "wikimedia", "whatsapp", "telegram",
    "blogspot", "wordpress", "amazon", "flipkart", "github", "stackoverflow",
}

# Second-level domains assembled out of job-board vocabulary. Two or more of
# these words in one SLD ("freshers"+"hunt", "internship"+"hub", "govt"+
# "internship") is a mirror site with very few exceptions; one alone is not
# enough, or "careem" and "jobstreet"-style real employers would be swept up.
_MIRROR_WORDS = (
    "job", "jobs", "intern", "interns", "internship", "internships", "career",
    "careers", "hire", "hiring", "hired", "fresher", "freshers", "placement",
    "placements", "vacancy", "vacancies", "recruit", "recruitment", "sarkari",
    "govt", "government", "naukri", "apply", "opening", "openings", "offcampus",
)

# A path that reads like a company's own careers section.
_EMPLOYER_PATH = re.compile(
    r"/(careers?|jobs?|opportunit(?:y|ies)|openings?|vacanc(?:y|ies)|"
    r"work-with-us|join-us|hiring|internships?)\b", re.I,
)

# Public suffixes that take two labels, so the registrable domain of
# "acme.co.in" is "acme" and not "co".
_TWO_LABEL_SUFFIXES = {
    "co.in", "co.uk", "com.au", "co.jp", "com.br", "co.za", "com.sg", "net.in",
    "org.in", "gov.in", "ac.in", "edu.in", "com.mx", "co.nz", "org.uk", "ac.uk",
}


def host_of(url: str) -> str:
    try:
        host = (urllib.parse.urlparse(url).hostname or "").lower()
    except Exception:  # noqa: BLE001
        return ""
    return host[4:] if host.startswith("www.") else host


def registrable(host: str) -> str:
    """The name a human would call this site — "acme" out of "careers.acme.co.in"."""
    parts = [p for p in (host or "").split(".") if p]
    if len(parts) < 2:
        return parts[0] if parts else ""
    if ".".join(parts[-2:]) in _TWO_LABEL_SUFFIXES and len(parts) >= 3:
        return parts[-3]
    return parts[-2]


def vendor_of(url: str) -> str:
    """Which ATS is this posting on? "" when it is not on one."""
    host = host_of(url)
    if not host:
        return ""
    for vendor, pattern in _ATS_VENDORS:
        if pattern.search(host):
            return vendor
    return ""


def _looks_like_a_mirror(sld: str) -> bool:
    """Is this second-level domain built out of job-board words?

    Splits on separators AND scans for the words inside a run-together name
    ("freshershunt" has no separator to split on), then requires two distinct
    hits so a single job-ish word cannot condemn a real company.
    """
    if not sld:
        return False
    low = sld.lower()
    hits = {w for w in _MIRROR_WORDS if w in low}
    # "internships" contains "intern" and "internship"; collapse to the stems
    # actually distinct in meaning, or every plural would count twice.
    stems = {w.rstrip("s") for w in hits}
    stems.discard("")
    return len(stems) >= 2


def classify(url: str) -> str:
    """One of: ats | employer | board | aggregator | unknown."""
    host = host_of(url)
    if not host:
        return "unknown"
    if vendor_of(url):
        return "ats"
    labels = set(host.split("."))
    if labels & _BOARD_BRANDS:
        return "board"
    if labels & _AGGREGATOR_BRANDS:
        return "aggregator"
    sld = registrable(host)
    if _looks_like_a_mirror(sld):
        return "aggregator"
    # Google Forms is the one generic host an employer genuinely owns a form on;
    # every India student internship posted outside an ATS tends to live there.
    if host.endswith("docs.google.com") or host.endswith("forms.gle"):
        return "employer"
    try:
        path = urllib.parse.urlparse(url).path or ""
    except Exception:  # noqa: BLE001
        path = ""
    if _EMPLOYER_PATH.search(path):
        return "employer"
    return "unknown"


# Classes worth carrying past discovery. `board` and `aggregator` are dropped:
# the first is another adapter's job, the second owns no form to submit.
KEEP = ("ats", "employer", "unknown")

# Classes the agent may treat as an employer's own intake.
TRUSTED = ("ats", "employer")


def is_useful(url: str) -> bool:
    """Could this URL plausibly be an employer's own application page?

    A URL with no host at all is not "unknown", it is unusable — and `unknown`
    is a KEEP class, so answering that for a blank string let junk through the
    one gate that was supposed to stop it.
    """
    return bool(host_of(url)) and classify(url) in KEEP


def is_trusted(url: str) -> bool:
    return classify(url) in TRUSTED
