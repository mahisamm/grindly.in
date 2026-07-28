"""Discovery source: internships on employers' OWN pages, found by web search.

This is the source that makes unattended applying possible at all. Every board
adapter returns listings whose only apply path is that board — which needs the
user's account, and on LinkedIn/Naukri/Indeed/Unstop is never submitted from our
servers (resolver.TIER_C). Searching the open web instead surfaces the same
internships where the EMPLOYER published them: a careers page, a Google Form, an
ATS posting. The candidate holds no account there, so there is no account to
lose, and resolver grades those TIER_A — the one tier the agent may submit on
its own.

Same `fetch(domains, limit, uid) -> [job dict]` contract as every board adapter,
so worker.py treats it as one more source. It opens no browser: search results
plus the resolver's existing link-following are enough to reach a real form.
"""
from __future__ import annotations
import concurrent.futures
from datetime import datetime, timezone
import hashlib
import html
import json
import os
import re
import urllib.request

import flags
import hosts
import websearch

# Must match this module's import name: worker.py resolves a listing's source
# back to its module with importlib.import_module(source), so a mismatch here
# would strand every one of these listings at "source unavailable this run".
SOURCE = "websource"

# Query templates. Each aims at a page an employer OWNS, not a board listing:
# ATS hosts are where a company's own postings live, and "apply"/"careers"
# wording is what a real application page says about itself.
#
# `{role}` is a job title the candidate could hold — "machine learning
# engineer", "computer vision engineer" — not a skill and not a domain. See
# agent/rolequeries.py for why: nobody advertises a "YOLOv8 internship".
_TEMPLATES = [
    # site:-scoped ATS queries carry this source. Verified against the live
    # instance: they return real Indian employers' own postings (Paytm, FamPay,
    # Epifi, Graviton, Ogilvy...), many of them the /apply page itself. Every
    # one is TIER_A — the candidate holds no account there.
    "site:boards.greenhouse.io {role} intern india",
    "site:jobs.lever.co {role} intern india",
    "site:jobs.ashbyhq.com {role} intern india",
    # The two vendors atsboards can also read directly. Worth searching as well
    # as polling: a search finds the COMPANIES, and every ATS URL that lands in
    # the jobs table becomes a board atsboards asks directly from then on.
    "site:jobs.smartrecruiters.com {role} intern india",
    "site:apply.workable.com {role} intern india",
    # Employer-owned forms and careers pages outside any ATS.
    "{role} internship india apply site:docs.google.com/forms",
    "{role} internship india careers apply {year}",
]

# How many role titles get the full template treatment. Seven templates each, so
# nine roles is ~63 queries a run — up from the fifteen the old three-domain
# budget allowed, and affordable now that the queries run concurrently.
MAX_ROLES = int(os.environ.get("GRINDLY_SEARCH_ROLES", "9"))
QUERY_WORKERS = int(os.environ.get("GRINDLY_SEARCH_WORKERS", "4"))

# Deliberately UNQUOTED. An exact-phrase query ("web development intern")
# matches almost nothing on a real posting, whose title is "Software Developer
# Intern" or "SDE Intern - Frontend"; the first live run returned zero for every
# quoted template while the unquoted equivalents returned twenty.

_INTERN_WORDS = ("intern", "internship", "trainee", "apprentice")
_YEAR_RE = re.compile(r"\b(20\d{2})\b")

# The same words, matched as WORDS. A substring test files "Head of SOX and
# Internal Controls", "Senior Internal Auditor" and "Lead Engineer, Internal
# Engineering" as internships — all three are real titles this returned, and a
# student applying to a Head-of-SOX role under their own name is the kind of
# mistake that is remembered by that employer.
_INTERN_RE = re.compile(
    r"\b(internships?|interns?|trainees?|apprenticeships?|apprentices?)\b", re.I,
)


def says_internship(title: str) -> bool:
    """Does this title name an internship? Shared with atsboards.py so the two
    discovery sources cannot drift into different opinions about the question."""
    return bool(_INTERN_RE.search(title or ""))


# ---- where, how much, how long ---------------------------------------------
#
# All three were left empty by both employer-hosted sources, which quietly
# disabled three things at once: the user's stipend_min filter had nothing to
# filter on, their location preference had nothing to compare, and the dashboard
# showed a blank where the answer to "can I actually take this?" belongs. The
# facts are in the posting text; nothing was reading them.

_CITY = (
    "bengaluru", "bangalore", "mumbai", "new delhi", "delhi", "ncr", "gurgaon",
    "gurugram", "hyderabad", "pune", "chennai", "noida", "kolkata", "ahmedabad",
    "jaipur", "chandigarh", "kochi", "coimbatore", "indore", "bhubaneswar",
    "nagpur", "visakhapatnam", "thiruvananthapuram", "mysuru", "mysore",
)
_CITY_RE = re.compile(r"\b(" + "|".join(_CITY) + r")\b", re.I)
_INDIA_RE = re.compile(r"\bindia\b", re.I)
_REMOTE_RE = re.compile(r"\b(remote|work from home|wfh|anywhere in india)\b", re.I)

# Stipend, as an Indian posting writes it: "₹15,000/month", "INR 20000 per
# month", "Rs. 10,000 - 25,000", "25k/month", "unpaid".
_STIPEND_RE = re.compile(
    r"(?:(?:₹|rs\.?|inr)\s*([\d,]{3,12}(?:\s*[-–to]{1,3}\s*[\d,]{3,12})?)"
    r"|(\b\d{1,3}(?:,\d{3})+|\b\d{1,3}\s*k\b)"
    r")\s*(?:/|per\s+)?\s*(month|mo\b|annum|year|yr\b|week)?",
    re.I,
)
_UNPAID_RE = re.compile(r"\bunpaid\b|\bno stipend\b", re.I)
_DURATION_RE = re.compile(
    r"\b(\d{1,2})\s*(?:\+)?\s*(month|months|week|weeks)\b(?:\s*(?:internship|duration))?",
    re.I,
)


def parse_stipend(text: str) -> str:
    """A stipend out of posting text, or "" when it doesn't say.

    Deliberately conservative: a number with no currency marker and no period is
    as likely to be a headcount or a revenue figure as a salary, and a wrong
    stipend on the dashboard is worse than a blank one.
    """
    if not text:
        return ""
    window = text[:4000]
    if _UNPAID_RE.search(window):
        return "Unpaid"
    m = _STIPEND_RE.search(window)
    if not m:
        return ""
    amount = (m.group(1) or m.group(2) or "").strip()
    if not amount:
        return ""
    period = (m.group(3) or "").lower()
    # No currency symbol AND no period means we are guessing at a bare number.
    if not m.group(1) and not period:
        return ""
    unit = {"mo": "month", "yr": "year", "annum": "year"}.get(period, period)
    return f"₹{amount}/{unit}" if unit else f"₹{amount}"


def parse_duration(text: str) -> str:
    if not text:
        return ""
    m = _DURATION_RE.search(text[:4000])
    if not m:
        return ""
    n, unit = m.group(1), m.group(2).lower().rstrip("s")
    return f"{n} {unit}s" if n != "1" else f"1 {unit}"


def parse_location(text: str) -> str:
    """Best-effort place, preferring a named city over the country.

    A blank location is not neutral — the user asked for Remote or for a
    specific city, and a listing with no place cannot be checked against either,
    so it silently bypasses their preference.
    """
    if not text:
        return ""
    window = text[:6000]
    city = _CITY_RE.search(window)
    remote = bool(_REMOTE_RE.search(window))
    if city:
        place = city.group(1).title()
        return f"Remote — {place}, India" if remote else f"{place}, India"
    if _INDIA_RE.search(window):
        return "Remote — India" if remote else "India"
    return "Remote" if remote else ""


def in_india(*texts: str) -> bool:
    """Could a candidate in India take this role?

    atsboards has always enforced this from the board's own location field.
    websource enforced nothing, so a run that asked five times for "india"
    returned EU Greenhouse boards, Wellfound and Bayt — the word in the query is
    a hint to the engine, never a filter on the result.
    """
    blob = " ".join(t for t in texts if t)[:8000]
    if _INDIA_RE.search(blob) or _CITY_RE.search(blob):
        return True
    # A bare "Remote" on a foreign company's posting usually means remote in
    # THEIR country, so it only counts when India is named somewhere too.
    return False


def enabled() -> bool:
    """Both switches must agree: the feature flag AND a usable provider. A flag
    on with no reachable search backend would log one failure per query and
    discover nothing."""
    return flags.search_discovery_enabled() and websearch.configured()


# A real posting lives at a per-job path. A company's ATS landing page —
# jobs.lever.co/acme — lists every opening and has no form of its own, so it can
# never be applied to. Live proof: "Careers", "Level AI" and "Stable Money" all
# arrived as candidates and scored on the aggregate text of dozens of unrelated
# roles.
_ATS_POSTING = re.compile(
    r"(?:jobs\.lever\.co/[^/]+/[0-9a-f-]{8,}"          # lever: company/uuid
    r"|greenhouse\.io/[^/]+/jobs/\d+"                   # greenhouse: company/jobs/id
    r"|ashbyhq\.com/[^/]+/[0-9a-f-]{8,}"                # ashby: company/uuid
    r"|smartrecruiters\.com/[^/]+/\d{6,}"               # smartrecruiters: company/id
    r"|apply\.workable\.com/[^/]+/j/[0-9A-Z]{6,}"       # workable: company/j/shortcode
    r"|docs\.google\.com/forms)", re.I,
)
_ATS_HOST = re.compile(
    r"(?:lever\.co|greenhouse\.io|ashbyhq\.com|smartrecruiters\.com|workable\.com)",
    re.I,
)

# Titles that belong to an index page rather than one role.
_INDEX_TITLES = re.compile(
    r"^(careers?|jobs?|openings?|work with us|current openings|"
    r"job application for)?$", re.I,
)

# A title that counts the roles on the page is an index announcing itself:
# "53 Fullstack Developer Intern Jobs in India", "Top 10 Internships". Both
# arrived live and outscored real postings, because the matcher then scored the
# aggregate text of every unrelated role listed below.
_COUNTS_ROLES = re.compile(
    r"^\s*(?:top\s+)?\d{1,4}\s*\+?\s+[\w /,-]{0,40}\b(jobs?|internships?|openings?|"
    r"vacanc(?:y|ies)|roles?|opportunit(?:y|ies))\b", re.I,
)

# Paths that list roles rather than hold one. The second alternative matters as
# much as the first: `web3.career/full-stack+intern-jobs` is an index whose last
# segment merely ENDS in "jobs" rather than being it, and that one reached the
# candidate list and scored 84 off the pooled text of every role on the page.
_INDEX_PATH = re.compile(
    r"/(jobs?|careers?|internships?|openings?|vacanc(?:y|ies)|search|browse|"
    r"category|categories|tag|tags|page)/?$"
    r"|[-+_](jobs|internships|openings|vacancies)/?$"
    r"|[?&](page|start|offset)=", re.I,
)

# How many distinct role-ish headings a page may contain before it is a list of
# jobs rather than one job.
_MAX_ROLE_MENTIONS = int(os.environ.get("GRINDLY_INDEX_ROLE_LIMIT", "6"))


def _is_a_single_posting(title: str, url: str) -> bool:
    """Is this one applyable role, or a company's list of roles?

    On a known ATS the URL settles it: a per-job path is a posting, a bare
    company path is the index. Elsewhere, three cheap tells — a title that
    counts roles, a title that is only the word "Careers", or a path that ends
    at a listing segment. `looks_like_an_index` adds a fourth once the page text
    is in hand, which is the one that catches a listicle whose title says
    nothing.
    """
    if _ATS_HOST.search(url):
        return bool(_ATS_POSTING.search(url))
    title = (title or "").strip()
    if _INDEX_TITLES.match(title) or _COUNTS_ROLES.search(title):
        return False
    return not _INDEX_PATH.search(url or "")


def looks_like_an_index(text: str) -> bool:
    """Does the fetched page hold many postings rather than one?

    Structure, not wording. A real posting names its role once in the heading
    and then describes it; an index repeats "... Intern", "... Developer",
    "Apply Now" once per row. Counting those repeats catches the aggregator
    listicles that no title test can — the AICTE portal, ambitionbox's "53
    jobs", web3.career — all of which passed every check we had and then scored
    in the 80s and 90s off the pooled text of dozens of unrelated roles.
    """
    if not text:
        return False
    window = text[:20000].lower()
    apply_buttons = len(re.findall(r"\bapply\s+(?:now|here|online)\b", window))
    role_headings = len(re.findall(
        r"\b(?:intern|internship|developer|engineer|analyst|designer)\b(?=[^.]{0,30}"
        r"(?:\||·|•|–|—|\d{1,2}\s*(?:days?|hours?|months?)\s+ago))", window))
    stipend_rows = len(re.findall(r"₹\s*[\d,]{3,}", window))
    return max(apply_buttons, role_headings, stipend_rows) > _MAX_ROLE_MENTIONS


def _looks_like_an_internship(title: str, snippet: str) -> bool:
    """Cheap relevance gate before anything expensive touches this result.

    Search returns careers-page indexes and blog posts alongside real postings.
    Requiring an intern-ish word in the title or snippet is not a match score —
    matcher.py still scores every survivor against the user's resume — it just
    keeps the resolver's page budget for things that could plausibly be applied
    to.
    """
    # The TITLE must say intern, not merely the page somewhere.
    #
    # Matching on title-or-snippet let a company's ATS index through whenever
    # any listed role happened to be an internship — "Level AI", "Drivetrain"
    # and "Endpoint Clinical" all arrived that way, and one reached the queue as
    # a "Director, Commercial Operations" internship. A real posting names the
    # role in its title; that is the one reliable signal here, and a few missed
    # listings cost far less than applying to the wrong job in someone's name.
    if not says_internship(title):
        return False
    blob = f"{title} {snippet}".lower()
    # A posting whose text advertises only past recruitment years is almost
    # always archived. Keep this relative to the current year: a fixed list
    # silently let 2025 listings through as soon as the calendar changed.
    years = [int(year) for year in _YEAR_RE.findall(blob)]
    if years and max(years) < datetime.now(timezone.utc).year:
        return False
    return True


def _company_from(title: str, url: str) -> str:
    """Best-effort employer name.

    ATS URLs carry the company as a path segment, which is more reliable than
    parsing a page title. Otherwise fall back to the title's "at <Company>" or
    the host. Never returns empty — an application filed under a blank company
    is unreadable on the dashboard.
    """
    m = re.search(
        r"(?:lever\.co|greenhouse\.io|ashbyhq\.com|smartrecruiters\.com"
        r"|apply\.workable\.com)/([^/?#]+)", url, re.I,
    )
    if m:
        return _tidy_company(m.group(1))
    m = re.search(r"\bat\s+([A-Z][\w&.\- ]{2,40})", title)
    if m:
        return m.group(1).strip()[:60]
    host = re.sub(r"^www\.", "", re.sub(r"^https?://", "", url).split("/")[0])
    return _tidy_company(host.split(".")[0]) or "Unknown"


# Trailing digits and vendor suffixes an ATS appends to make a slug unique when
# the name is taken. Left in, the dashboard reads "Stable Money1", "Quantco-",
# "Plus-2" and "Bookeeapp" — which is what the employer is called nowhere.
_SLUG_NOISE = re.compile(r"(?:[-_ ]?\d+|[-_]+|inc|llc|ltd|pvt|technologies|hq)$", re.I)


def _tidy_company(slug: str) -> str:
    name = (slug or "").replace("-", " ").replace("_", " ").strip()
    prev = None
    while name and name != prev:
        prev = name
        name = _SLUG_NOISE.sub("", name).strip()
    return name.title()[:60]


def _clean_title(title: str) -> str:
    """Pull the ROLE out of a page title.

    Titles come in both orders — "SDE Intern | Acme" and "Acme - SDE Intern" —
    so taking the first segment threw the role away half the time. Live, that
    turned real postings into "Drivetrain", "Endpoint Clinical" and "Stable
    Money": unreadable on the dashboard, and worse, the title is a scoring
    signal, so the listing lost the one word that made it a match.

    Prefer whichever segment actually names a role.
    """
    raw = title.strip()
    parts = [p.strip() for p in re.split(r"\s+[|\-–—]\s+", raw) if p.strip()]
    chosen = next(
        (p for p in parts if any(w in p.lower() for w in _INTERN_WORDS)),
        parts[0] if parts else raw,
    )
    # Greenhouse titles every page "Job Application for ..."; left in, that
    # becomes the role name the user reads.
    chosen = re.sub(r"^job application for\s+", "", chosen, flags=re.I)
    chosen = re.sub(r"\s*[@(]\s*[\w&.\- ]+\)?$", "", chosen)
    chosen = re.sub(r"\s+at\s+[A-Z][\w&.\- ]{2,40}$", "", chosen)
    return (chosen or raw).strip()[:120]


def _infer_skills(text: str) -> list[str]:
    known = (
        "python", "java", "javascript", "typescript", "react", "node", "django",
        "flask", "sql", "postgresql", "mongodb", "aws", "docker", "kubernetes",
        "figma", "excel", "tableau", "power bi", "machine learning", "nlp",
        "android", "ios", "flutter", "marketing", "seo", "content", "design",
    )
    low = text.lower()
    return [k for k in known if k in low][:8]


_TAGS = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.S | re.I)
_MARKUP = re.compile(r"<[^>]+>")


# The big three ATSs publish their postings as JSON, and that is the ONLY way to
# read them. Lever and Ashby render client-side, so fetching their HTML returns
# "You need to enable JavaScript to run this app" — 51 characters, no
# description. Greenhouse serves HTML, but it is the company's marketing site
# navigation; the posting body is not in it. Scraping any of the three gave the
# matcher boilerplate to score against, which is why real internships kept
# coming back at 5-17 with the candidate's own skills listed on the page.
_API_PATTERNS = [
    (re.compile(r"greenhouse\.io/(?:embed/job_app\?for=)?([^/?#]+)/jobs/(\d+)", re.I),
     lambda c, j: f"https://boards-api.greenhouse.io/v1/boards/{c}/jobs/{j}"),
    (re.compile(r"lever\.co/([^/?#]+)/([0-9a-f-]{8,})", re.I),
     lambda c, j: f"https://api.lever.co/v0/postings/{c}/{j}"),
]


_ASHBY = re.compile(r"ashbyhq\.com/([^/?#]+)/([0-9a-f-]{8,})", re.I)


def _jd_from_ashby(url: str) -> str:
    """Ashby publishes a whole board, not one posting, so fetch the board and
    pick the job out of it.

    Worth the extra bytes: Ashby renders client-side, so its HTML is the string
    "You need to enable JavaScript to run this app" — 51 characters. Live
    candidates from Ashby were reaching the scorer with ~160 characters of
    description and could not possibly match.
    """
    m = _ASHBY.search(url)
    if not m:
        return ""
    org, job_id = m.group(1), m.group(2).lower()
    try:
        req = urllib.request.Request(
            f"https://api.ashbyhq.com/posting-api/job-board/{org}",
            headers={"User-Agent": "Grindly/1.0", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            board = json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001
        print(f"[websource] ashby board miss ({type(e).__name__}) for {org}")
        return ""
    for job in board.get("jobs") or []:
        if str(job.get("id", "")).lower() == job_id:
            text = job.get("descriptionPlain") or _MARKUP.sub(" ", job.get("descriptionHtml") or "")
            return re.sub(r"\s+", " ", html.unescape(text)).strip()[:6000]
    return ""


def _jd_from_api(url: str) -> str:
    """Read a posting through its ATS's own JSON API, when it has one."""
    ashby = _jd_from_ashby(url)
    if ashby:
        return ashby
    for pattern, build in _API_PATTERNS:
        m = pattern.search(url)
        if not m:
            continue
        try:
            req = urllib.request.Request(
                build(m.group(1), m.group(2)),
                headers={"User-Agent": "Grindly/1.0", "Accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            print(f"[websource] ats api miss ({type(e).__name__}) for {url[:60]}")
            return ""
        # Greenhouse calls it `content` (HTML-escaped), Lever `descriptionPlain`
        # plus a list of requirement sections.
        parts = [
            data.get("content") or "",
            data.get("descriptionPlain") or data.get("description") or "",
        ]
        for block in data.get("lists") or []:
            parts.append(block.get("text") or "")
            parts.append(_MARKUP.sub(" ", block.get("content") or ""))
        text = html.unescape(" ".join(p for p in parts if p))
        text = _MARKUP.sub(" ", html.unescape(text))
        return re.sub(r"\s+", " ", text).strip()[:6000]
    return ""


def scrape_jd(url: str, uid: str = "") -> str:
    """Fetch the real job description behind a search result.

    Not an optimisation — it is what makes these listings scoreable at all. A
    board card arrives with a skills list; a search result arrives with a
    one-line snippet, so matcher.score_job saw "0 of your skills mentioned" and
    scored every employer-hosted internship ~5 against a threshold of 65. Real
    roles at DevRev, CloudSEK, Thena and Enterpret were discarded that way. The
    worker's own JD re-scoring could not rescue them either: it only re-reads
    the top few by initial score, which is exactly the score being starved.

    Plain HTTP, no browser — ATS postings are server-rendered. Returns "" on any
    failure; the caller keeps the snippet and the listing simply scores as it
    did before.
    """
    # An ATS API answer is authoritative; only fall back to HTML for pages that
    # have no API (a company's own careers page, a Google Form).
    api = _jd_from_api(url)
    if len(api) > 200:
        return api
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"),
            "Accept-Language": "en-IN,en;q=0.9",
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read(400_000).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        print(f"[websource] jd fetch failed ({type(e).__name__}) for {url[:60]}")
        return ""
    text = _MARKUP.sub(" ", _TAGS.sub(" ", raw))
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()[:6000]


def _queries_for(roles: list[str]) -> list[str]:
    """Every search this run will issue, deduped and in a stable order."""
    year = datetime.now(timezone.utc).year
    out: list[str] = []
    seen: set[str] = set()
    for role in (roles or [])[:MAX_ROLES]:
        role = (role or "").strip()
        if not role:
            continue
        for template in _TEMPLATES:
            q = template.format(role=role, year=year)
            if q not in seen:
                seen.add(q)
                out.append(q)
    return out


def fetch(roles: list[str], limit: int = 25, uid: str = "") -> list[dict]:
    """Search the web for employer-hosted internships for these role titles.

    `roles` are job titles, not skills — see rolequeries.py. The parameter used
    to be `domains` and was fed the user's two profile domains, which is how a
    resume full of computer-vision work was searched for as "web developement"
    and nothing else.
    """
    if not enabled():
        return []

    queries = _queries_for(roles)
    # Concurrent, because the budget went from fifteen queries to ~sixty and
    # serially that is five minutes of a sweep. Four at a time: SearXNG paces its
    # own upstreams, and a burst wide enough to get this server's IP blocked
    # would end discovery for every user at once.
    results: list[tuple[str, list[dict]]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, QUERY_WORKERS)) as ex:
        for q, found in zip(queries, ex.map(lambda q: websearch.search(q, limit=8), queries)):
            results.append((q, found))

    jobs: list[dict] = []
    seen: set[str] = set()
    for _query, found in results:
        for r in found:
            url = r["url"]
            if url in seen or len(jobs) >= limit:
                continue
            seen.add(url)
            if not _looks_like_an_internship(r["title"], r["snippet"]):
                continue
            title = _clean_title(r["title"])
            # An index page has no form to submit; scoring it means scoring the
            # aggregate text of every unrelated role the company lists.
            if not _is_a_single_posting(title, url):
                continue
            jobs.append({
                # Stable across runs so the same posting dedupes instead of
                # reappearing as new work every sweep.
                "external_id": hashlib.sha1(url.encode()).hexdigest()[:16],
                "canonical": _canonical(url),
                "host_class": hosts.classify(url),
                "vendor": hosts.vendor_of(url),
                "title": title,
                "company": _company_from(r["title"], url),
                "location": parse_location(f"{title} {r['snippet']}"),
                "stipend": "",
                "duration": "",
                "skills": _infer_skills(f"{title} {r['snippet']}"),
                "url": url,
                "jd_text": r["snippet"],
                "source": SOURCE,
            })

    # Enrich with the real posting text BEFORE anything is judged on it. Every
    # gate below reads better from 6,000 characters of the posting than from a
    # 400-character search snippet, and the matcher scores on it too.
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, QUERY_WORKERS)) as ex:
        texts = list(ex.map(lambda j: scrape_jd(j["url"], uid), jobs))
    enriched = 0
    for j, jd in zip(jobs, texts):
        if len(jd) > len(j["jd_text"]):
            j["jd_text"] = jd
            # Re-derive skills from the full text; the title alone rarely names
            # the stack, and skills are what the matcher actually compares on.
            j["skills"] = _infer_skills(f"{j['title']} {jd}") or j["skills"]
            enriched += 1
        body = j["jd_text"]
        j["location"] = j["location"] or parse_location(f"{j['title']} {body}")
        j["stipend"] = parse_stipend(body)
        j["duration"] = parse_duration(body)

    kept: list[dict] = []
    dropped = {"index": 0, "not_india": 0, "duplicate": 0}
    canonical_seen: set[str] = set()
    for j in jobs:
        if looks_like_an_index(j["jd_text"]):
            dropped["index"] += 1
            continue
        # The word "india" in a query is a hint to the engine, never a filter on
        # the result — five of these queries said india and returned EU boards.
        if not in_india(j["title"], j["location"], j["jd_text"]):
            dropped["not_india"] += 1
            continue
        if j["canonical"] in canonical_seen:
            dropped["duplicate"] += 1
            continue
        canonical_seen.add(j["canonical"])
        kept.append(j)

    print(f"[websource] {len(kept)} employer-hosted candidate(s) from "
          f"{websearch.provider()} over {len(queries)} quer(ies) "
          f"({enriched} with a full description); dropped "
          f"{dropped['index']} index page(s), {dropped['not_india']} outside India, "
          f"{dropped['duplicate']} duplicate(s)")
    return kept


def _canonical(url: str) -> str:
    """One identity per posting, whatever address it arrived at."""
    try:
        import atsboards

        return atsboards.canonical_key(url)
    except Exception:  # noqa: BLE001 — circular import in a test harness, say
        return (url or "").strip().lower()


def close(uid: str = "") -> None:
    """No browser context to release — kept so worker.py can call close() on
    every source without special-casing this one."""
    return None
