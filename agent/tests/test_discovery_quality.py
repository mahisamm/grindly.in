"""The quality gates on discovery, and the rubric that grades them.

Every case here is a real result from a measured production run. The listing
that scored 91 was a government portal's `fetch_city.php?city=Pune`; the one
that scored 77 was ambitionbox's "53 Fullstack Developer Intern Jobs in India".
Both outranked genuine postings at CloudSEK and Bookee, because the matcher was
scoring the pooled text of every unrelated role on an index page.
"""
import atsboards
import discovery_score
import websource


# ---- index pages are not job postings --------------------------------------

def test_a_title_that_counts_roles_is_an_index():
    for title in ["53 Fullstack Developer Intern Jobs in India (Updated Jul, 2026)",
                  "Top 10 Internships for Freshers",
                  "250+ Software Engineer Jobs"]:
        assert not websource._is_a_single_posting(title, "https://x.com/a")


def test_a_listing_path_is_an_index():
    for url in ["https://web3.career/full-stack+intern-jobs",
                "https://acme.com/jobs",
                "https://acme.com/internships/",
                "https://acme.com/search?page=2"]:
        assert not websource._is_a_single_posting("Full Stack Intern", url)


def test_a_page_repeating_apply_now_is_an_index():
    """The tell no title test can catch: a listicle whose heading reads like a
    single role, with thirty rows underneath it."""
    page = " ".join(["Software Intern Apply Now ₹15,000"] * 12)
    assert websource.looks_like_an_index(page)


def test_a_real_posting_is_not_an_index():
    page = (
        "Software Development Intern at Acme, Bengaluru. About the role: you will "
        "build features across our stack. Requirements: Python, React. Stipend "
        "₹25,000/month for a 6 months internship. Apply now."
    )
    assert not websource.looks_like_an_index(page)
    assert websource._is_a_single_posting(
        "Software Development Intern", "https://acme.com/careers/sde-intern-2026")


def test_an_ats_posting_path_is_always_a_single_posting():
    assert websource._is_a_single_posting(
        "SDE Intern", "https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26-4aaa")
    assert not websource._is_a_single_posting("Careers", "https://jobs.lever.co/acme")


# ---- India ------------------------------------------------------------------

def test_the_word_india_in_a_query_is_not_a_filter_on_the_result():
    """Five templates said "india" and the run still returned EU Greenhouse
    boards, Wellfound and Bayt. The gate has to read the RESULT."""
    assert websource.in_india("SDE Intern", "Bengaluru", "")
    assert websource.in_india("SDE Intern", "", "Office in Gurugram, India")
    assert not websource.in_india("SDE Intern", "Berlin, Germany", "Remote")
    assert not websource.in_india("SDE Intern", "", "")


def test_a_bare_remote_does_not_count_as_india():
    """Remote on a US company's posting means remote in the US, and an
    application to a role the candidate cannot legally take costs them their
    credibility with that employer."""
    assert not websource.in_india("Intern", "Remote", "Work from anywhere")
    assert websource.in_india("Intern", "Remote", "Remote — anywhere in India")


# ---- location, stipend, duration -------------------------------------------

def test_a_location_is_read_out_of_the_posting():
    assert websource.parse_location("Intern, based in our Bengaluru office") == "Bengaluru, India"
    assert websource.parse_location("Remote role, India only") == "Remote — India"
    assert websource.parse_location("Berlin office") == ""


def test_a_stipend_is_read_out_of_the_posting():
    assert websource.parse_stipend("Stipend: ₹25,000/month") == "₹25,000/month"
    assert websource.parse_stipend("INR 20000 per month") == "₹20000/month"
    assert websource.parse_stipend("This is an unpaid internship") == "Unpaid"


def test_a_bare_number_is_never_guessed_at_as_a_stipend():
    """A wrong stipend on the dashboard is worse than a blank one."""
    assert websource.parse_stipend("We serve 50,000 customers") == ""
    assert websource.parse_stipend("Team of 200 engineers") == ""


def test_a_duration_is_read_out_of_the_posting():
    assert websource.parse_duration("6 months internship") == "6 months"
    assert websource.parse_duration("Duration: 12 weeks") == "12 weeks"
    assert websource.parse_duration("no timeframe given") == ""


# ---- one posting, one identity ---------------------------------------------

def test_the_same_greenhouse_job_on_three_hosts_is_one_posting():
    keys = {
        atsboards.canonical_key("https://boards.greenhouse.io/acme/jobs/123"),
        atsboards.canonical_key("https://job-boards.greenhouse.io/acme/jobs/123"),
        atsboards.canonical_key("https://job-boards.eu.greenhouse.io/acme/jobs/123"),
    }
    assert len(keys) == 1


def test_two_different_jobs_keep_two_identities():
    assert (atsboards.canonical_key("https://boards.greenhouse.io/acme/jobs/1")
            != atsboards.canonical_key("https://boards.greenhouse.io/acme/jobs/2"))


def test_a_non_ats_url_is_its_own_identity():
    assert atsboards.canonical_key("https://acme.com/careers/x") == "https://acme.com/careers/x"


# ---- company names ----------------------------------------------------------

def test_a_slug_is_cleaned_into_the_name_the_employer_uses():
    """Live output read "Stable Money1", "Bookeeapp", "Quantco-" and "Openx" —
    which is what the company is called nowhere."""
    assert websource._company_from("", "https://jobs.lever.co/stable-money1/x") == "Stable Money"
    assert websource._company_from("", "https://jobs.lever.co/quantco-/x") == "Quantco"
    assert websource._company_from("", "https://jobs.lever.co/plus-2/x") == "Plus"


# ---- posting age ------------------------------------------------------------

def test_a_posting_date_becomes_an_age():
    import datetime

    today = datetime.datetime.now(datetime.timezone.utc).isoformat()
    assert atsboards._age_days(today) == 0
    assert atsboards._age_days("2020-01-01T00:00:00Z") > 1000
    assert atsboards._age_days(None) is None
    assert atsboards._age_days("not a date") is None


def test_a_stale_posting_is_not_wanted():
    old = {"location": "Bengaluru, India", "title": "SDE Intern", "jd": "",
           "posted_days": atsboards.MAX_AGE_DAYS + 1}
    fresh = dict(old, posted_days=3)
    undated = dict(old, posted_days=None)
    assert not atsboards._wanted(old)
    assert atsboards._wanted(fresh)
    # Some boards publish no date at all; rejecting those drops whole vendors.
    assert atsboards._wanted(undated)


# ---- the rubric itself ------------------------------------------------------

def _perfect_report():
    listings = []
    for i in range(30):
        listings.append({
            "company": f"company{i}", "host_class": "ats", "vendor": ["greenhouse",
            "lever", "ashby", "smartrecruiters", "workable"][i % 5],
            "canonical": f"greenhouse:c{i}:{i}", "url": f"https://x/{i}",
            "jd_chars": 3000, "location": "Bengaluru, India", "posted_days": 5,
            "stipend": "₹25,000/month",
        })
    return {
        "plan": {"domains": ["web development", "ai"], "skills": ["python", "react"],
                 "min_match_score": 65},
        "keyword_sets": [[r] for r in [
            "web developer", "ai engineer", "python developer", "react developer",
            "machine learning engineer", "data analyst", "backend developer",
            "frontend developer", "software engineer", "devops engineer",
            "computer vision engineer", "data engineer"]],
        "web_queries": [{"query": f"q{i}"} for i in range(60)],
        "engines_answering": ["brave", "duckduckgo", "yandex", "bing"],
        "ats_boards": [{"vendor": ["greenhouse", "lever", "ashby", "smartrecruiters",
                                   "workable"][i % 5], "slug": f"c{i}",
                        "india_internships": 1} for i in range(200)],
        "listings": listings,
    }


def test_a_perfect_run_scores_at_the_top():
    assert discovery_score.score(_perfect_report())["total"] >= 95


def test_an_empty_run_scores_zero():
    empty = {"plan": {"domains": [], "skills": []}, "keyword_sets": [],
             "web_queries": [], "engines_answering": [], "ats_boards": [],
             "listings": []}
    assert discovery_score.score(empty)["total"] == 0


def test_junk_results_cost_the_signal_dimension():
    rep = _perfect_report()
    for l in rep["listings"][:20]:
        l["host_class"] = "aggregator"
    assert discovery_score.score(rep)["dimensions"]["signal"]["score"] < 60


def test_one_employer_dominating_costs_the_diversity_dimension():
    rep = _perfect_report()
    for l in rep["listings"]:
        l["company"] = "cloudsek"
    assert discovery_score.score(rep)["dimensions"]["diversity"]["score"] < 40


def test_an_unsearched_domain_costs_the_coverage_dimension():
    """The exact regression that went unnoticed: a stated domain never queried."""
    rep = _perfect_report()
    rep["plan"]["domains"] = ["web development", "ai", "quantum computing"]
    before = discovery_score.score(rep)["dimensions"]["coverage"]["score"]
    rep["keyword_sets"] = [["web developer"]]
    assert discovery_score.score(rep)["dimensions"]["coverage"]["score"] < before


def test_the_grade_is_explainable():
    text = discovery_score.explain(_perfect_report())
    assert "TOTAL" in text
    for dim in ("BREADTH", "COVERAGE", "DIVERSITY", "SIGNAL", "FIT"):
        assert dim in text


def test_the_weights_sum_to_one():
    assert abs(sum(discovery_score.WEIGHTS.values()) - 1.0) < 1e-9


def test_a_hyphenated_or_ranged_duration_is_read():
    """The original pattern needed a space and a plural, so it missed every
    hyphenated form — which is how a job TITLE writes it."""
    assert websource.parse_duration("6-month Internship, Bengaluru") == "6 months"
    assert websource.parse_duration("Duration: 3 to 6 months") == "3 months"
    assert websource.parse_duration("a 3–6 months programme") == "3 months"
    assert websource.parse_duration("12 week programme") == "12 weeks"


def test_pay_status_is_reported_when_no_figure_is_given():
    """Sampled across ten real India internships on ATS boards, not one carried
    a number. "The posting doesn't say" is a real answer; a blank is not."""
    assert websource.parse_pay_note(
        "Internship duration and compensation will be discussed during the "
        "interview process.") == "Stated at interview"
    assert websource.parse_pay_note(
        "You'll be rewarded a competitive salary as well as generous perks."
    ) == "Competitive — amount not stated"
    assert websource.parse_pay_note("Stipend (if applicable) and a certificate") \
        == "Stated at interview"
    assert websource.parse_pay_note("This is an unpaid internship") == "Unpaid"
    assert websource.parse_pay_note("We build developer tools.") == ""


def test_a_pay_note_is_never_put_where_a_number_belongs():
    """`stipend` feeds the user's stipend_min filter, which compares numbers —
    "Competitive" there parses as zero and hides every posting from anyone who
    set a floor."""
    text = "You'll be rewarded a competitive salary."
    assert websource.parse_stipend(text) == ""
    assert websource.parse_pay_note(text)


# ---- unvouched hosts have to prove themselves ------------------------------

def test_a_link_farm_url_is_not_a_job_posting(monkeypatch):
    """One live run returned eight of these — jiphi.lc/go, violebez.de/onizvo,
    kir.sj/bi. Unknown host (kept by design, since a small employer's own domain
    looks identical), no index markers in a two-character path, and an
    intern-ish title straight out of a poisoned search result. What they cannot
    do is serve a job description."""
    import websearch

    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(websource, "enabled", lambda: True)
    monkeypatch.setattr(websearch, "search", lambda q, limit=10: [{
        "title": "Software Development Intern at Acme",
        "url": "http://jiphi.lc/go",
        "snippet": "Internship in Bengaluru, India. Apply now.",
    }])
    monkeypatch.setattr(websource, "scrape_jd", lambda url, uid="": "")
    assert websource.fetch(["software engineer"], limit=5) == []


def test_a_readable_unvouched_host_is_still_kept(monkeypatch):
    """A small employer on a domain nobody has seen is exactly the listing the
    boards miss — the rule is readability, not reputation."""
    import websearch

    monkeypatch.setattr(websearch, "configured", lambda: True)
    monkeypatch.setattr(websource, "enabled", lambda: True)
    monkeypatch.setattr(websearch, "search", lambda q, limit=10: [{
        "title": "Software Development Intern at Somestartup",
        "url": "https://somestartup.xyz/2026-summer-programme",
        "snippet": "Internship in Bengaluru, India.",
    }])
    monkeypatch.setattr(
        websource, "scrape_jd",
        lambda url, uid="": "We are hiring an intern in Bengaluru, India. " * 40)
    assert len(websource.fetch(["software engineer"], limit=5)) == 1


def test_a_punctuation_only_location_never_overrides_a_real_one(monkeypatch):
    """`", ".join(city, country)` on a posting that gave neither produces ", ",
    which is truthy — it overrode a correctly parsed location and then failed
    every India check downstream."""
    monkeypatch.setattr(websource, "_POSTING_META", {})
    websource._remember_meta("https://x/1", location=", ", company="  ")
    assert websource.posting_meta("https://x/1").get("location") is None
    websource._remember_meta("https://x/1", location="Bengaluru, India")
    assert websource.posting_meta("https://x/1")["location"] == "Bengaluru, India"


def test_a_workable_url_without_a_slug_names_no_company():
    """`apply.workable.com/<company>/j/<code>` names the employer;
    `apply.workable.com/j/<code>` does not. The shared pattern captured "j" from
    the second and filed eight real postings under a company called J."""
    assert websource._company_from(
        "SDE Intern", "https://apply.workable.com/acme/j/ABC123") == "Acme"
    assert websource._company_from(
        "SDE Intern at Entru", "https://apply.workable.com/j/ABC123") == "Entru"
    assert websource._company_from(
        "SDE Intern", "https://weekday-1.workable.com/j/ABC123") == "Weekday"


def test_a_job_title_is_never_used_as_a_company_name():
    """Live output carried an employer called "Machine Learning Engineer Intern
    at Entru"."""
    name = websource._company_from(
        "Machine Learning Engineer Intern at Machine Learning Engineer",
        "https://someplace.example/posting")
    assert not _READS_LIKE_A_ROLE_TEST(name), name


def _READS_LIKE_A_ROLE_TEST(name):
    return bool(websource._READS_LIKE_A_ROLE.search(name or ""))
