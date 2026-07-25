"""Web discovery — the source that finds employer-hosted internships.

This is the only source whose listings the agent may submit unattended, because
an employer's own form involves no account of the user's. So the tests care
about two things: that it never returns a board link dressed up as an employer
page, and that every failure degrades to "found nothing" instead of taking the
run down.
"""
import pytest

import websearch
import websource


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    monkeypatch.delenv("GRINDLY_SEARCH_PROVIDER", raising=False)
    monkeypatch.delenv("SEARCH_API_KEY", raising=False)
    monkeypatch.setenv("GRINDLY_SEARCH_DISCOVERY_ENABLED", "1")


def _results(*urls):
    return [
        {"title": "Software Development Intern at Acme", "url": u,
         "snippet": "We are hiring a 2026 summer intern. Apply now."}
        for u in urls
    ]


# ---- board results must never come back as employer destinations -----------

@pytest.mark.parametrize("url", [
    "https://www.linkedin.com/jobs/view/123",
    "https://in.indeed.com/viewjob?jk=abc",
    "https://internshala.com/internship/detail/x",
    "https://www.naukri.com/job-listings-x",
    "https://unstop.com/internships/x",
    "https://www.glassdoor.com/job/x",
])
def test_job_boards_are_filtered_out(url):
    """A board link is either already covered by its own adapter or needs the
    user's account — carrying it further only spends the resolver's page budget
    to reach the same conclusion."""
    assert websearch._is_useful(url) is False


@pytest.mark.parametrize("url", [
    "https://uk.linkedin.com/jobs/view/9",
    "https://www.glassdoor.co.in/Job/india-web-developer-jobs.htm",
    "https://in.indeed.com/viewjob?jk=1",
])
def test_regional_twins_are_filtered_too(url):
    """These brands run one site per country. Matching full ".com" hosts let
    every regional twin through — a Glassdoor link survived the very first
    live run that way."""
    assert websearch._is_useful(url) is False


@pytest.mark.parametrize("url", [
    "https://myinternships.in/internships/web-development",
    "https://en.wikipedia.org/wiki/World_Wide_Web",
    "https://web.whatsapp.com/",
])
def test_aggregators_and_noise_are_filtered(url):
    """Straight from the first live search: an aggregator that reprints
    listings and owns no form, plus two pages that are not jobs at all."""
    assert websearch._is_useful(url) is False


def test_an_employer_page_survives():
    assert websearch._is_useful("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa23") is True
    assert websearch._is_useful("https://careers.acme.com/intern") is True


# ---- relevance ------------------------------------------------------------

def test_a_page_with_no_intern_wording_is_dropped():
    assert websource._looks_like_an_internship("Senior Staff Engineer", "10+ years") is False


def test_an_archived_posting_is_dropped():
    """Applying to a 2021 posting is noise to the employer and to the user."""
    assert websource._looks_like_an_internship(
        "Summer Intern 2021", "Applications for our 2021 batch") is False


def test_a_current_internship_survives():
    assert websource._looks_like_an_internship(
        "Software Development Internship", "Hiring interns for 2026") is True


# ---- company naming -------------------------------------------------------

def test_company_comes_from_the_ats_path_when_present():
    assert websource._company_from("Intern", "https://jobs.lever.co/rocket-labs/9") == "Rocket Labs"


def test_company_falls_back_to_the_title_then_the_host():
    assert websource._company_from("Data Intern at Acme Corp", "https://x.io/1") == "Acme Corp"
    assert websource._company_from("Intern", "https://careers.zeta.com/1") == "Careers"


def test_a_company_name_is_never_blank():
    """A row filed under a blank company is unreadable on the dashboard."""
    assert websource._company_from("", "https://example.com/x")


# ---- the fetch contract ---------------------------------------------------

def test_fetch_returns_nothing_while_the_flag_is_off(monkeypatch):
    monkeypatch.setenv("GRINDLY_SEARCH_DISCOVERY_ENABLED", "0")
    assert websource.fetch(["web development"]) == []


def test_fetch_returns_nothing_when_no_provider_is_reachable(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: False)
    assert websource.fetch(["web development"]) == []


def test_fetch_shapes_results_like_every_other_adapter(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(
        websearch, "search",
        lambda q, limit=10: _results("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa"),
    )
    jobs = websource.fetch(["web development"], limit=5)
    assert jobs, "a valid employer result must produce a job"
    j = jobs[0]
    assert set(j) >= {"external_id", "title", "company", "url", "skills", "source"}
    assert j["source"] == "websource"
    assert j["company"] == "Acme"


def test_the_same_posting_keeps_one_stable_id(monkeypatch):
    """External ids must not churn between runs, or every sweep re-queues the
    same posting as new work."""
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(
        websearch, "search",
        lambda q, limit=10: _results("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa"),
    )
    first = websource.fetch(["web development"], limit=5)[0]["external_id"]
    second = websource.fetch(["web development"], limit=5)[0]["external_id"]
    assert first == second


def test_one_url_is_never_returned_twice(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(
        websearch, "search",
        lambda q, limit=10: _results("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa", "https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa"),
    )
    assert len(websource.fetch(["web development"], limit=5)) == 1


def test_a_search_backend_failure_never_raises(monkeypatch):
    """Discovery must degrade to 'found nothing', never take the run down."""
    monkeypatch.setattr(websearch, "configured", lambda: True)

    def boom(*a, **k):
        raise ConnectionError("searxng unreachable")

    monkeypatch.setattr(websearch, "search", boom)
    with pytest.raises(ConnectionError):
        websearch.search("x")          # sanity: the stub really raises
    monkeypatch.setattr(websearch, "search", lambda q, limit=10: [])
    assert websource.fetch(["web development"]) == []


def test_search_itself_swallows_a_dead_backend(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(websearch, "_from_searxng", lambda q, n: (_ for _ in ()).throw(OSError("down")))
    assert websearch.search("anything") == []


def test_an_unknown_provider_returns_nothing_rather_than_crashing(monkeypatch):
    monkeypatch.setenv("GRINDLY_SEARCH_PROVIDER", "nonesuch")
    monkeypatch.setenv("SEARCH_API_KEY", "k")
    assert websearch.search("x") == []


# ---- the job description is what makes these listings scoreable --------------

def test_scrape_jd_strips_scripts_and_keeps_the_skills(monkeypatch):
    """A board card arrives with a skills list; a search result arrives with a
    one-line snippet. Without the real posting text matcher.score_job saw "0 of
    your skills mentioned" and scored every employer-hosted internship ~5
    against a threshold of 65 — real roles at DevRev, CloudSEK, Thena and
    Enterpret were thrown away that way."""
    page = (
        b"<html><head><style>.x{color:red}</style>"
        b"<script>var t='Kubernetes';</script></head>"
        b"<body><h1>Machine Learning Intern</h1>"
        b"<p>You will use Python, SQL and Docker.</p></body></html>"
    )

    class _Resp:
        def read(self, _n=None): return page
        def __enter__(self): return self
        def __exit__(self, *a): return False

    monkeypatch.setattr(websource.urllib.request, "urlopen", lambda *a, **k: _Resp())
    jd = websource.scrape_jd("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa")
    assert "Python, SQL and Docker" in jd
    assert "Machine Learning Intern" in jd
    # Script/style content must not leak in — a variable named after a tool the
    # posting never asks for would score the listing on a skill nobody wants.
    assert "Kubernetes" not in jd


def test_scrape_jd_returns_empty_on_failure(monkeypatch):
    """The caller keeps its snippet; a dead page must never break discovery."""
    def boom(*a, **k):
        raise TimeoutError("no response")

    monkeypatch.setattr(websource.urllib.request, "urlopen", boom)
    assert websource.scrape_jd("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa") == ""


def test_fetch_upgrades_the_snippet_and_reinfers_skills(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(
        websearch, "search",
        lambda q, limit=10: _results("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa"),
    )
    monkeypatch.setattr(
        websource, "scrape_jd",
        lambda url, uid="": "We need a Python and PostgreSQL intern with Docker experience. " * 4,
    )
    job = websource.fetch(["software"], limit=3)[0]
    assert "PostgreSQL" in job["jd_text"]
    # Skills are what the matcher compares on; the title alone rarely names the
    # stack, so they must be re-derived from the full description.
    assert {"python", "postgresql", "docker"} <= set(job["skills"])


def test_a_failed_jd_fetch_leaves_the_listing_usable(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(
        websearch, "search",
        lambda q, limit=10: _results("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa"),
    )
    monkeypatch.setattr(websource, "scrape_jd", lambda url, uid="": "")
    job = websource.fetch(["software"], limit=3)[0]
    assert job["jd_text"], "the search snippet must survive as a fallback"


# ---- an index page is not an application ------------------------------------

@pytest.mark.parametrize("title,url", [
    ("Careers", "https://jobs.lever.co/drivetrain"),
    ("Level AI", "https://jobs.ashbyhq.com/levelai"),
    ("Stable Money", "https://jobs.lever.co/stable-money1"),
])
def test_an_ats_landing_page_is_not_a_posting(title, url):
    """A company's ATS index lists every opening and owns no form of its own, so
    it can never be applied to. All three of these arrived as live candidates
    and were scored on the aggregate text of dozens of unrelated roles."""
    assert websource._is_a_single_posting(title, url) is False


@pytest.mark.parametrize("title,url", [
    ("Software Intern", "https://jobs.lever.co/drivetrain/edb8a8f7-16ac-4177-bf2e-99c1"),
    ("ML Intern", "https://jobs.ashbyhq.com/certifyos/4bcdec99-9f2e-416c-8e26-4aaa"),
    ("Careers at Klaviyo", "https://boards.greenhouse.io/klaviyo/jobs/7721795003"),
])
def test_a_per_job_url_is_a_posting(title, url):
    """On a known ATS the URL settles it, even when the page title is unhelpful."""
    assert websource._is_a_single_posting(title, url) is True


def test_a_non_ats_page_falls_back_to_its_title():
    assert websource._is_a_single_posting("Careers", "https://acme.com/careers") is False
    assert websource._is_a_single_posting("Backend Intern", "https://acme.com/x") is True


def test_the_ats_title_prefix_is_stripped():
    """Greenhouse titles every page "Job Application for ..." — left in, that
    becomes the role name on the user's dashboard."""
    assert websource._clean_title(
        "Job Application for Machine Learning Intern at CloudSEK") == "Machine Learning Intern"


def test_an_index_page_is_not_saved_by_a_snippet_that_mentions_interns():
    """Matching title-OR-snippet let a company's ATS index through whenever any
    role it listed happened to be an internship. "Level AI", "Drivetrain" and
    "Endpoint Clinical" all arrived that way, and one reached the queue as a
    "Director, Commercial Operations" internship."""
    assert websource._looks_like_an_internship("Level AI", "we hire interns across teams") is False
    assert websource._looks_like_an_internship("Director, Commercial Operations", "internships available") is False


def test_a_posting_that_names_the_role_survives():
    assert websource._looks_like_an_internship("Software Engineer Intern @ Simular", "join us") is True
