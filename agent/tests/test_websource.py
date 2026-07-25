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
    assert websearch._is_useful("https://jobs.lever.co/acme/123") is True
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
        lambda q, limit=10: _results("https://jobs.lever.co/acme/1"),
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
        lambda q, limit=10: _results("https://jobs.lever.co/acme/1"),
    )
    first = websource.fetch(["web development"], limit=5)[0]["external_id"]
    second = websource.fetch(["web development"], limit=5)[0]["external_id"]
    assert first == second


def test_one_url_is_never_returned_twice(monkeypatch):
    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(
        websearch, "search",
        lambda q, limit=10: _results("https://jobs.lever.co/acme/1", "https://jobs.lever.co/acme/1"),
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
