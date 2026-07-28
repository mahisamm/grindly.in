"""Discovery straight from employers' ATS boards.

This source exists because the search-based one cannot be relied on: measured on
the production VPS, every general engine SearXNG fronts either serves a CAPTCHA,
suspends the IP, or (Bing) answers while silently ignoring `site:` — so the
ATS-scoped queries that employer-hosted discovery is built on all returned zero
and the source ran on nothing but its own disk cache.

So these tests care about the two things that make it worth having: that a board
API failing degrades to "found nothing" instead of taking a run down, and that
what it does return is genuinely an internship a student in India could take.
"""
import json

import pytest

import atsboards
import websource

# Captured before the autouse fixture stubs it out, so the two tests that are
# ABOUT slug learning can still reach the real implementation.
_REAL_SLUGS_SEEN = atsboards._slugs_seen_before


@pytest.fixture(autouse=True)
def no_cache(tmp_path, monkeypatch):
    """Each test gets its own cache file and an empty in-memory cache — a hit
    left over from another test would make the assertion meaningless."""
    monkeypatch.setattr(atsboards, "_CACHE_FILE", str(tmp_path / "boards.json"))
    monkeypatch.setattr(atsboards, "_CACHE", {})
    monkeypatch.setattr(atsboards, "_loaded", False)
    monkeypatch.setattr(atsboards, "_slugs_seen_before", lambda: [])


def _only(vendor, slug, payload, monkeypatch):
    """Point the source at exactly one board with a known payload."""
    monkeypatch.setattr(atsboards, "BOARDS", {vendor: [slug]})
    monkeypatch.setattr(
        atsboards, "_get_json",
        lambda url: payload if slug in url else None,
    )


GREENHOUSE = {"jobs": [
    {"title": "Software Engineering Intern",
     "location": {"name": "Bengaluru, India"},
     "absolute_url": "https://boards.greenhouse.io/acme/jobs/123",
     "content": "&lt;p&gt;Work on our Python and React stack.&lt;/p&gt;"},
    {"title": "Senior Internal Auditor",
     "location": {"name": "Mumbai, India"},
     "absolute_url": "https://boards.greenhouse.io/acme/jobs/124",
     "content": "Audit things."},
    {"title": "Software Engineering Intern",
     "location": {"name": "San Francisco, CA"},
     "absolute_url": "https://boards.greenhouse.io/acme/jobs/125",
     "content": "US only."},
]}

LEVER = [
    {"text": "Engineering Intern", "categories": {"location": "Bangalore"},
     "hostedUrl": "https://jobs.lever.co/acme/abc12345-0000",
     "descriptionPlain": "Build data pipelines in SQL and Python.",
     "lists": [{"text": "Requirements", "content": "<li>Docker</li>"}]},
]

ASHBY = {"jobs": [
    {"title": "Product Intern", "location": "Remote, India",
     "jobUrl": "https://jobs.ashbyhq.com/acme/abcd1234-0000",
     "descriptionPlain": "Help ship the roadmap. Figma a plus."},
]}


# ---- what counts as an internship ------------------------------------------

def test_an_internal_auditor_is_not_an_internship(monkeypatch):
    """"intern" is a SUBSTRING of "internal". Matching it as one filed "Head of
    SOX and Internal Controls", "Senior Internal Auditor" and "Lead Engineer,
    Internal Engineering" as student internships — all three real titles, live,
    from real boards. A student applying to a Head-of-SOX role under their own
    name is remembered by that employer."""
    _only("greenhouse", "acme", GREENHOUSE, monkeypatch)
    titles = [j["title"] for j in atsboards.fetch(["python"], limit=10)]
    assert "Software Engineering Intern" in titles
    assert not any("Auditor" in t for t in titles)


def test_websource_agrees_about_the_same_titles():
    """Both sources ask the same question, so they must not answer it
    differently — a listing filtered out of one and into the other is a bug
    nobody can see from either side."""
    assert websource.says_internship("Software Engineering Intern")
    assert websource.says_internship("Summer Internship 2026")
    assert websource.says_internship("Graduate Trainee")
    assert not websource.says_internship("Senior Internal Auditor")
    assert not websource.says_internship("Head of SOX and Internal Controls")
    assert not websource.says_internship("Lead Engineer, Internal Engineering")


def test_a_role_outside_india_is_not_returned(monkeypatch):
    """These boards are global. An Indian student cannot take the San Francisco
    posting, and applying anyway costs them credibility with that employer."""
    _only("greenhouse", "acme", GREENHOUSE, monkeypatch)
    urls = [j["url"] for j in atsboards.fetch([], limit=10)]
    assert "https://boards.greenhouse.io/acme/jobs/123" in urls
    assert "https://boards.greenhouse.io/acme/jobs/125" not in urls


def test_a_bare_remote_is_not_treated_as_india(monkeypatch):
    """"Remote" on a US company's posting means remote in the US."""
    payload = {"jobs": [{
        "title": "Engineering Intern", "location": "Remote",
        "absolute_url": "https://boards.greenhouse.io/acme/jobs/9", "content": "x",
    }]}
    _only("greenhouse", "acme", payload, monkeypatch)
    assert atsboards.fetch([], limit=10) == []


# ---- the description is the whole point ------------------------------------

@pytest.mark.parametrize("vendor,slug,payload,needle", [
    ("greenhouse", "acme", GREENHOUSE, "Python and React"),
    ("lever", "acme", LEVER, "data pipelines"),
    ("ashby", "acme", ASHBY, "roadmap"),
])
def test_every_vendor_yields_a_real_description(vendor, slug, payload, needle, monkeypatch):
    """A listing that reaches the matcher with a one-line snippet scores ~5
    against a threshold of 65 — which is how real internships at DevRev,
    CloudSEK, Thena and Enterpret were all discarded. These APIs return the full
    posting in the same response, so there is no excuse for scoring a summary."""
    _only(vendor, slug, payload, monkeypatch)
    jobs = atsboards.fetch([], limit=10)
    assert jobs, f"{vendor} returned nothing"
    assert needle in jobs[0]["jd_text"]


def test_html_and_entities_are_stripped_from_the_description(monkeypatch):
    _only("greenhouse", "acme", GREENHOUSE, monkeypatch)
    jd = atsboards.fetch([], limit=10)[0]["jd_text"]
    assert "<p>" not in jd and "&lt;" not in jd


def test_skills_come_from_the_full_text_not_the_title(monkeypatch):
    """Skills are what the matcher compares on, and a title almost never names
    the stack."""
    _only("lever", "acme", LEVER, monkeypatch)
    skills = atsboards.fetch([], limit=10)[0]["skills"]
    assert "python" in skills and "sql" in skills and "docker" in skills


# ---- failure degrades, never propagates ------------------------------------

def test_a_dead_board_returns_nothing_instead_of_raising(monkeypatch):
    """One company's board 404ing must not end discovery for the run."""
    monkeypatch.setattr(atsboards, "BOARDS", {"greenhouse": ["gone"]})
    monkeypatch.setattr(atsboards, "_get_json", lambda url: None)
    assert atsboards.fetch(["python"], limit=10) == []


def test_one_dead_board_does_not_hide_a_live_one(monkeypatch):
    monkeypatch.setattr(atsboards, "BOARDS", {"greenhouse": ["gone", "acme"]})
    monkeypatch.setattr(
        atsboards, "_get_json",
        lambda url: GREENHOUSE if "acme" in url else None,
    )
    assert len(atsboards.fetch([], limit=10)) == 1


def test_a_board_that_raises_is_survived(monkeypatch):
    def boom(url):
        raise TimeoutError("upstream")
    monkeypatch.setattr(atsboards, "BOARDS", {"greenhouse": ["acme"]})
    monkeypatch.setattr(atsboards, "_get_json", boom)
    assert atsboards.fetch([], limit=10) == []


def test_no_database_is_not_a_reason_to_discover_nothing(monkeypatch):
    """`_slugs_seen_before` reads the applications table. A database that is
    down must cost the learned slugs, not the whole source."""
    import db
    monkeypatch.setattr(
        db, "known_ats_urls", lambda *a, **k: (_ for _ in ()).throw(OSError("down")),
    )
    assert _REAL_SLUGS_SEEN() == []


# ---- the contract worker.py relies on --------------------------------------

def test_it_looks_like_every_other_source(monkeypatch):
    """worker.py resolves a listing's source back to its module by name and
    calls close() on it, so a mismatch strands every listing at "source
    unavailable this run"."""
    assert atsboards.SOURCE == "atsboards"
    assert atsboards.close("anyone") is None


def test_each_job_carries_the_keys_the_pipeline_reads(monkeypatch):
    _only("greenhouse", "acme", GREENHOUSE, monkeypatch)
    job = atsboards.fetch(["python"], limit=10)[0]
    for key in ("external_id", "title", "company", "url", "jd_text", "skills", "source"):
        assert job.get(key) not in (None, ""), key
    assert job["source"] == "atsboards"


def test_the_same_posting_keeps_the_same_id_across_runs(monkeypatch):
    """A run that re-identifies yesterday's posting as new work re-applies to
    it."""
    _only("greenhouse", "acme", GREENHOUSE, monkeypatch)
    first = atsboards.fetch([], limit=10)[0]["external_id"]
    monkeypatch.setattr(atsboards, "_CACHE", {})
    assert atsboards.fetch([], limit=10)[0]["external_id"] == first


def test_keywords_order_results_but_never_filter_them(monkeypatch):
    """matcher.py scores every survivor against the user's actual resume.
    Dropping a posting here on a keyword they never typed hides roles they
    would have wanted."""
    payload = {"jobs": [
        {"title": "Marketing Intern", "location": {"name": "Delhi, India"},
         "absolute_url": "https://boards.greenhouse.io/acme/jobs/1", "content": "SEO and content."},
        {"title": "Engineering Intern", "location": {"name": "Pune, India"},
         "absolute_url": "https://boards.greenhouse.io/acme/jobs/2", "content": "Python, Docker."},
    ]}
    _only("greenhouse", "acme", payload, monkeypatch)
    jobs = atsboards.fetch(["python"], limit=10)
    assert len(jobs) == 2                      # nothing dropped
    assert jobs[0]["title"] == "Engineering Intern"  # the asked-for one first


# ---- the cache, which is what keeps this off the boards' radar -------------

def test_a_board_is_fetched_once_per_ttl_not_once_per_user(monkeypatch):
    """This runs per user per sweep. Without the cache, six users cost six
    identical passes over every board in the list."""
    calls = []
    monkeypatch.setattr(atsboards, "BOARDS", {"greenhouse": ["acme"]})
    monkeypatch.setattr(
        atsboards, "_get_json",
        lambda url: (calls.append(url), GREENHOUSE)[1],
    )
    atsboards.fetch([], limit=10)
    atsboards.fetch([], limit=10)
    assert len(calls) == 1


def test_a_corrupt_cache_file_is_ignored_not_fatal(tmp_path, monkeypatch):
    bad = tmp_path / "boards.json"
    bad.write_text("{not json", encoding="utf-8")
    monkeypatch.setattr(atsboards, "_CACHE_FILE", str(bad))
    monkeypatch.setattr(atsboards, "_loaded", False)
    monkeypatch.setattr(atsboards, "_CACHE", {})
    _only("greenhouse", "acme", GREENHOUSE, monkeypatch)
    assert len(atsboards.fetch([], limit=10)) == 1


def test_an_expired_entry_is_refetched(monkeypatch):
    calls = []
    monkeypatch.setattr(atsboards, "BOARDS", {"greenhouse": ["acme"]})
    monkeypatch.setattr(
        atsboards, "_get_json", lambda url: (calls.append(url), GREENHOUSE)[1],
    )
    atsboards.fetch([], limit=10)
    stale_ts = atsboards._CACHE["greenhouse::acme"][0] - atsboards.CACHE_TTL - 1
    atsboards._CACHE["greenhouse::acme"] = (stale_ts, GREENHOUSE)
    atsboards.fetch([], limit=10)
    assert len(calls) == 2


# ---- learning new boards ----------------------------------------------------

def test_slugs_are_learned_from_urls_the_system_already_found(monkeypatch):
    """Discovery that only ever looks at a hardcoded list cannot learn. Anything
    websource surfaces on a day the search engines answer names a company worth
    asking directly from then on."""
    import db
    monkeypatch.setattr(db, "known_ats_urls", lambda *a, **k: [
        "https://boards.greenhouse.io/newco/jobs/1",
        "https://jobs.lever.co/otherco/abc12345-1111",
        "https://jobs.ashbyhq.com/thirdco/abcd1234-2222",
        "https://internshala.com/internship/detail/x",
    ])
    learned = _REAL_SLUGS_SEEN()
    assert ("greenhouse", "newco") in learned
    assert ("lever", "otherco") in learned
    assert ("ashby", "thirdco") in learned
    assert len(learned) == 3  # the board link is not an ATS slug


def test_every_seeded_slug_is_a_plausible_one():
    """A slug that 404s costs a request and yields nothing, and a typo here is
    invisible in the logs of a source expected to return nothing for most boards
    on most days."""
    # SmartRecruiters slugs are case-SENSITIVE identifiers ("BoschGroup",
    # "AveryDennison") and 404 when lowercased, unlike the big three's, which
    # are lowercase by convention.
    case_sensitive = {"smartrecruiters"}
    for vendor, slugs in atsboards.BOARDS.items():
        assert vendor in atsboards._API
        assert len(set(slugs)) == len(slugs), f"{vendor} has a duplicate slug"
        for s in slugs:
            assert s == s.strip()
            if vendor not in case_sensitive:
                assert s == s.lower()
            assert "/" not in s and " " not in s, s


def test_a_board_that_changed_shape_costs_that_board_only(monkeypatch):
    """Greenhouse documents `location` as an object and Ashby as a string. A
    board returning the other one used to raise inside the result loop, and the
    exception emptied the entire sweep rather than that one listing."""
    monkeypatch.setattr(atsboards, "BOARDS", {"greenhouse": ["broken", "acme"]})
    monkeypatch.setattr(
        atsboards, "_get_json",
        lambda url: {"jobs": "not a list"} if "broken" in url else GREENHOUSE,
    )
    assert len(atsboards.fetch([], limit=10)) == 1


def test_a_posting_the_company_publishes_on_its_own_site_still_resolves(monkeypatch):
    """Greenhouse's `absolute_url` is wherever the company chose to publish. For
    Stripe that is stripe.com/jobs/listing/... — employer-owned, but nothing
    downstream can tell it holds a form without fetching it, so live it resolved
    to the platform channel and TIER_C: never sent. The board's own URL is the
    same posting somewhere the tier is provable."""
    payload = {"jobs": [{
        "id": 42, "title": "Engineering Intern",
        "location": {"name": "Bengaluru, India"},
        "absolute_url": "https://stripe.com/jobs/listing/engineering-intern/42",
        "content": "Work on payments.",
    }]}
    _only("greenhouse", "stripe", payload, monkeypatch)
    assert atsboards.fetch([], limit=5)[0]["url"] == \
        "https://boards.greenhouse.io/stripe/jobs/42"


def test_a_company_already_on_greenhouse_keeps_the_url_it_advertises(monkeypatch):
    payload = {"jobs": [{
        "id": 7, "title": "Engineering Intern",
        "location": {"name": "Pune, India"},
        "absolute_url": "https://job-boards.eu.greenhouse.io/acme/jobs/7",
        "content": "x",
    }]}
    _only("greenhouse", "acme", payload, monkeypatch)
    assert atsboards.fetch([], limit=5)[0]["url"] == \
        "https://job-boards.eu.greenhouse.io/acme/jobs/7"


# ---- learning inside a single run -------------------------------------------

def test_a_company_found_on_the_web_is_polled_in_the_same_run():
    """The database path only closes the loop across RUNS, and only after a
    listing has been written — so a company a search surfaced this morning was
    not asked directly until tomorrow. This closes it inside one sweep."""
    assert atsboards.remember_slugs([
        "https://boards.greenhouse.io/freshco/jobs/9",
        "https://jobs.lever.co/anotherco/abc12345-1111",
        "https://apply.workable.com/thirdco/j/ABC123",
        "https://jobs.smartrecruiters.com/BigCo/744000123",
    ]) == 4
    learned = set(_REAL_SLUGS_SEEN())  # the fixture stubs the module attribute
    assert ("greenhouse", "freshco") in learned
    assert ("lever", "anotherco") in learned
    assert ("workable", "thirdco") in learned
    assert ("smartrecruiters", "BigCo") in learned


def test_a_company_is_only_learned_once():
    urls = ["https://boards.greenhouse.io/freshco/jobs/9"]
    assert atsboards.remember_slugs(urls) == 1
    assert atsboards.remember_slugs(urls) == 0


def test_a_board_link_names_no_ats_company():
    assert atsboards.remember_slugs([
        "https://internshala.com/internship/detail/x",
        "https://www.linkedin.com/jobs/view/1",
        "",
    ]) == 0


def test_the_learned_list_is_bounded(monkeypatch):
    """A bad day of results must not grow the poll list without limit."""
    monkeypatch.setattr(atsboards, "LEARNED_MAX", 5)
    atsboards.remember_slugs(
        f"https://boards.greenhouse.io/co{n}/jobs/1" for n in range(40))
    assert len(atsboards._LEARNED) == 5


def test_an_unwritable_learned_file_does_not_fail_discovery(monkeypatch):
    monkeypatch.setattr(atsboards, "_LEARNED_FILE", "/nonexistent\x00/bad.json")
    atsboards.remember_slugs(["https://boards.greenhouse.io/freshco/jobs/9"])
    assert ("greenhouse", "freshco") in atsboards._LEARNED
