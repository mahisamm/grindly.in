"""Destination resolution — where an application actually goes.

The point of these tests is the risk boundary, not the regexes: a listing must
only be classed Tier A when the destination genuinely has no user account behind
it, and anything ambiguous must fall back to the board.
"""
import pytest

import resolver


# ── ATS ─────────────────────────────────────────────────────────────────────

def test_listing_that_is_itself_an_ats_page_is_tier_a():
    job = {"url": "https://boards.greenhouse.io/acme/jobs/4123", "source": "linkedin"}
    dest = resolver.resolve(job)
    assert dest["channel"] == resolver.CHANNEL_ATS
    assert dest["tier"] == resolver.TIER_A
    assert dest["vendor"] == "greenhouse"


def test_ats_link_inside_the_job_description_is_followed():
    job = {"url": "https://internshala.com/internship/detail/x-123", "source": "internshala"}
    jd = "About us... To apply, visit https://jobs.lever.co/acme/abc-def and submit."
    dest = resolver.resolve(job, jd)
    assert dest["channel"] == resolver.CHANNEL_ATS
    assert dest["vendor"] == "lever"
    assert dest["target"] == "https://jobs.lever.co/acme/abc-def"


def test_every_known_ats_host_is_recognised():
    for host, vendor in (
        ("boards.greenhouse.io", "greenhouse"),
        ("jobs.lever.co", "lever"),
        ("jobs.ashbyhq.com", "ashby"),
        ("apply.workable.com", "workable"),
        ("jobs.smartrecruiters.com", "smartrecruiters"),
    ):
        assert resolver.ats_vendor(f"https://{host}/acme/role") == vendor


def test_a_board_url_is_never_mistaken_for_an_ats():
    assert resolver.ats_vendor("https://www.linkedin.com/jobs/view/123") is None
    assert resolver.ats_vendor("https://internshala.com/internship/detail/x") is None


# ── Google Forms ────────────────────────────────────────────────────────────

def test_google_form_in_the_jd_is_tier_a():
    job = {"url": "https://unstop.com/internships/x", "source": "unstop"}
    jd = "Apply here: https://docs.google.com/forms/d/e/1FAIpQLSabc123/viewform"
    dest = resolver.resolve(job, jd)
    assert dest["channel"] == resolver.CHANNEL_GOOGLE_FORM
    assert dest["tier"] == resolver.TIER_A
    assert "1FAIpQLSabc123" in dest["target"]


def test_forms_gle_shortlink_is_recognised():
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    dest = resolver.resolve(job, "Fill this form: https://forms.gle/AbCd1234")
    assert dest["channel"] == resolver.CHANNEL_GOOGLE_FORM


# ── Email ───────────────────────────────────────────────────────────────────

def test_company_hiring_mailbox_is_tier_a():
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    jd = "Interested candidates may write to careers@acmerobotics.in for details."
    dest = resolver.resolve(job, jd)
    assert dest["channel"] == resolver.CHANNEL_EMAIL
    assert dest["target"] == "careers@acmerobotics.in"


def test_send_your_resume_sentence_promotes_a_plain_company_address():
    job = {"url": "https://linkedin.com/jobs/view/1", "source": "linkedin"}
    jd = "Send your resume to priya.sharma@acmerobotics.in before Friday."
    dest = resolver.resolve(job, jd)
    assert dest["channel"] == resolver.CHANNEL_EMAIL
    assert dest["target"] == "priya.sharma@acmerobotics.in"


def test_free_mail_hr_address_is_refused():
    """The classic fake-internship pattern. Sending a student's resume and phone
    number to hr.acme@gmail.com is worse than not applying at all."""
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    dest = resolver.resolve(job, "Mail your CV to hracme2024@gmail.com")
    assert dest["channel"] == resolver.CHANNEL_PLATFORM


def test_noreply_and_platform_addresses_are_ignored():
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    jd = "noreply@internshala.com sent this. Questions? support@internshala.com"
    dest = resolver.resolve(job, jd)
    assert dest["channel"] == resolver.CHANNEL_PLATFORM


def test_a_bare_address_with_no_apply_intent_is_not_a_destination():
    job = {"url": "https://linkedin.com/jobs/view/1", "source": "linkedin"}
    jd = "Our CEO ravi@acmerobotics.in founded the company in 2019."
    dest = resolver.resolve(job, jd)
    assert dest["channel"] == resolver.CHANNEL_PLATFORM


# ── Fallback and tiers ──────────────────────────────────────────────────────

def test_no_employer_channel_falls_back_to_the_board():
    job = {"url": "https://www.linkedin.com/jobs/view/999", "source": "linkedin"}
    dest = resolver.resolve(job, "A normal job description with no apply link.")
    assert dest["channel"] == resolver.CHANNEL_PLATFORM
    assert dest["tier"] == resolver.TIER_C


def test_internshala_is_tier_b_and_everything_else_is_tier_c():
    assert resolver.platform_tier("internshala") == resolver.TIER_B
    for src in ("linkedin", "naukri", "indeed", "unstop", "", "some_new_board"):
        assert resolver.platform_tier(src) == resolver.TIER_C


def test_resolution_never_raises_on_junk_input():
    for job in ({}, {"url": None}, {"url": "not a url", "source": None}):
        dest = resolver.resolve(job, None)
        assert dest["channel"] in (
            resolver.CHANNEL_PLATFORM, resolver.CHANNEL_ATS,
            resolver.CHANNEL_EMAIL, resolver.CHANNEL_GOOGLE_FORM,
        )


# ── Following a careers page ────────────────────────────────────────────────

def test_careers_page_is_followed_to_find_the_real_form():
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    jd = "Apply on the company website: https://acmerobotics.in/careers"
    pages = {
        "https://acmerobotics.in/careers":
            '<a href="https://docs.google.com/forms/d/e/1FAIpQLSzz/viewform">Apply</a>',
    }
    dest = resolver.resolve(job, jd, fetch=pages.get)
    assert dest["channel"] == resolver.CHANNEL_GOOGLE_FORM
    assert "1FAIpQLSzz" in dest["target"]


def test_a_failing_fetch_degrades_to_the_board_instead_of_raising():
    def boom(url):
        raise RuntimeError("network down")

    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    jd = "Apply on the company website: https://acmerobotics.in/careers"
    dest = resolver.resolve(job, jd, fetch=boom)
    assert dest["channel"] == resolver.CHANNEL_PLATFORM


# ── Hostname parsing ────────────────────────────────────────────────────────

def test_host_strips_only_a_real_www_prefix():
    """str.lstrip takes a SET OF CHARACTERS, not a prefix. lstrip("www.") ate
    every leading w and dot, so "wellfound.com" became "ellfound.com" — which
    then missed the platform deny-list entirely."""
    assert resolver._host("https://www.linkedin.com/x") == "linkedin.com"
    assert resolver._host("https://wellfound.com/jobs/1") == "wellfound.com"
    assert resolver._host("https://wow.acme.in/c") == "wow.acme.in"
    assert resolver._host("https://www3.site.com/a") == "www3.site.com"
    assert resolver._host("https://w3schools.com/x") == "w3schools.com"


def test_a_w_prefixed_board_is_still_recognised_as_a_board():
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    dest = resolver.resolve(job, "Also posted at https://wellfound.com/jobs/999")
    assert dest["channel"] == resolver.CHANNEL_PLATFORM


# ── SSRF ────────────────────────────────────────────────────────────────────

def test_internal_addresses_are_never_fetchable():
    """A job description is attacker-controlled text. Anyone who can post a
    listing could otherwise point the agent at our own private network."""
    for url in (
        "http://169.254.169.254/latest/meta-data/",   # cloud metadata
        "http://web:3000/api/admin/users",            # compose service name
        "http://postgres:5432/",
        "http://localhost/x",
        "http://127.0.0.1/x",
        "http://10.0.0.5/x",
        "http://192.168.1.1/x",
        "http://[::1]/x",
        "http://db.internal/x",
        "http://printer.local/x",
        "ftp://acme.in/x",
        "file:///etc/passwd",
        "",
    ):
        assert resolver.is_fetchable(url) is False, url


def test_a_real_careers_page_is_fetchable():
    for url in ("https://acme.in/careers", "http://www.acmerobotics.in/jobs"):
        assert resolver.is_fetchable(url) is True


def test_internal_urls_never_become_a_destination_either():
    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    jd = "Apply on the company website: http://169.254.169.254/ and http://web:3000/apply"
    assert resolver._external_links(jd) == []
    dest = resolver.resolve(job, jd, fetch=lambda u: "<html></html>")
    assert dest["channel"] == resolver.CHANNEL_PLATFORM


def test_fetch_budget_is_respected():
    seen = []

    def fetch(url):
        seen.append(url)
        return ""

    job = {"url": "https://internshala.com/internship/detail/x", "source": "internshala"}
    jd = " ".join(f"https://site{i}.com/careers" for i in range(10))
    resolver.resolve(job, jd, fetch=fetch, max_follow=2)
    assert len(seen) == 2


@pytest.mark.parametrize("url,vendor", [
    ("https://boards.greenhouse.io/acme/jobs/1", "greenhouse"),
    ("https://job-boards.greenhouse.io/acme/jobs/1", "greenhouse"),
    ("https://job-boards.eu.greenhouse.io/acme/jobs/1", "greenhouse"),
    ("https://jobs.eu.lever.co/acme/abc12345", "lever"),
    ("https://jobs.ashbyhq.com/acme/abcd1234", "ashby"),
])
def test_every_host_a_vendor_serves_postings_from_is_recognised(url, vendor):
    """Greenhouse alone serves postings from three hostnames, and EU-hosted
    customers get a fourth. The exact-host map missed job-boards.eu.greenhouse.io,
    which graded four real Groww internships TIER_C — "never submitted from our
    servers" — when they sit on the employer's own ATS needing no account at
    all."""
    assert resolver.ats_vendor(url) == vendor


def test_a_lookalike_domain_is_not_an_ats():
    """Suffix matching must be on a domain boundary: greenhouse.io.evil.com is
    not Greenhouse."""
    assert resolver.ats_vendor("https://greenhouse.io.evil.com/acme/jobs/1") is None
    assert resolver.ats_vendor("https://notgreenhouse.io/acme/jobs/1") is None


# ── Google Forms, in every shape Google serves them ─────────────────────────

@pytest.mark.parametrize("url", [
    "https://docs.google.com/forms/d/e/1FAIpQLSfabc/viewform",
    # A Workspace company's own form. Two real Coalition Technologies
    # application forms arrived like this and were graded TIER_C — never sent,
    # on the one channel with no browser, no account and no captcha wall.
    "https://docs.google.com/a/coalitiontechnologies.com/forms/d/e/1FAIpQLSfabc/viewform",
    # What a browser copies out of the address bar for a multi-account session.
    "https://docs.google.com/forms/u/0/d/e/1FAIpQLSfabc/viewform",
    "https://forms.gle/AbCd1234",
])
def test_a_google_form_is_tier_a_however_google_addresses_it(url):
    dest = resolver.resolve({"url": url, "source": "websource"}, "")
    assert dest["tier"] == resolver.TIER_A
    assert dest["channel"] == resolver.CHANNEL_GOOGLE_FORM


# ── The Apply button on a careers page ──────────────────────────────────────

def test_an_apply_link_read_off_the_page_routes_the_application():
    """A company careers page owns no form: its Apply button points at the
    employer's ATS. Discovery reads that href off the page it already fetched
    and hands it over here — without it the listing resolved to the board
    channel with source "websource", TIER_C, and no adapter to send it."""
    job = {
        "url": "https://acme.example/careers/ml-intern",
        "source": "websource",
        "apply_links": ["https://boards.greenhouse.io/acme/jobs/4242424"],
    }
    dest = resolver.resolve(job, "We are hiring an ML intern.")
    assert dest["tier"] == resolver.TIER_A
    assert dest["channel"] == resolver.CHANNEL_ATS
    assert dest["target"] == "https://boards.greenhouse.io/acme/jobs/4242424"


def test_an_apply_link_outranks_an_ats_url_mentioned_in_the_prose():
    job = {
        "url": "https://acme.example/careers/ml-intern",
        "source": "websource",
        "apply_links": ["https://jobs.lever.co/acme/1234-abcd-5678"],
    }
    jd = "Our sister company also hires at https://boards.greenhouse.io/other/jobs/9"
    assert resolver.resolve(job, jd)["target"] == "https://jobs.lever.co/acme/1234-abcd-5678"


def test_apply_links_that_are_not_a_list_do_not_break_resolution():
    job = {"url": "https://acme.example/careers/x", "source": "websource",
           "apply_links": "https://boards.greenhouse.io/acme/jobs/4242424"}
    assert resolver.resolve(job, "")["channel"] == resolver.CHANNEL_ATS


# ── Postings that have been taken down ──────────────────────────────────────

def test_a_posting_that_bounced_to_the_board_index_reads_as_gone():
    """An ATS answers a removed posting with the company's board index, not a
    404 — 50KB of real job text that reads as a live posting to everything
    downstream."""
    assert resolver.looks_gone(
        "https://boards.greenhouse.io/truveta/jobs/4906665004",
        "https://job-boards.greenhouse.io/truveta?error=true",
    )


def test_a_posting_that_merely_moved_hosts_is_not_gone():
    assert not resolver.looks_gone(
        "https://boards.greenhouse.io/acme/jobs/4906665004",
        "https://job-boards.greenhouse.io/acme/jobs/4906665004",
    )


def test_a_url_with_no_posting_id_opts_out_of_the_check():
    # A careers page with no identifier cannot be tested this way, and guessing
    # would drop live listings.
    assert not resolver.looks_gone("https://acme.example/careers",
                                   "https://acme.example/careers/all")


def test_landing_on_the_same_url_is_never_gone():
    url = "https://jobs.lever.co/acme/1234-5678"
    assert not resolver.looks_gone(url, url)
