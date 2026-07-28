"""Host classification — the thing that decides what discovery is allowed to keep.

This replaced a denylist, and the reason it had to is the whole point of these
tests: a denylist is a record of the mirrors somebody already noticed. Eight of
them outranked real employers in one measured live run precisely because nobody
had written them down yet. So the cases below are split in two — the named ones
(a regression guard on real URLs from that run) and the shape-based ones (the
part that has to work on a domain nobody has ever seen).
"""
import hosts


# ---- ATS postings: the only tier the agent may submit unattended ------------

def test_every_supported_ats_is_recognised():
    for url, vendor in [
        ("https://boards.greenhouse.io/acme/jobs/123", "greenhouse"),
        ("https://job-boards.greenhouse.io/acme/jobs/123", "greenhouse"),
        ("https://job-boards.eu.greenhouse.io/acme/jobs/123", "greenhouse"),
        ("https://jobs.lever.co/acme/4bcdec99-9f2e-416c-8e26", "lever"),
        ("https://jobs.ashbyhq.com/acme/4bcdec99-9f2e", "ashby"),
        ("https://jobs.smartrecruiters.com/BoschGroup/744000123", "smartrecruiters"),
        ("https://apply.workable.com/acme/j/ABC123", "workable"),
        ("https://acme.myworkdayjobs.com/en-US/careers/job/x", "workday"),
        ("https://acme.darwinbox.in/ms/candidate/careers/x", "darwinbox"),
    ]:
        assert hosts.vendor_of(url) == vendor, url
        assert hosts.classify(url) == "ats", url
        assert hosts.is_trusted(url)


def test_greenhouses_three_hosts_are_one_vendor():
    """Greenhouse publishes the same posting on three hostnames; a live run
    returned all three at once. Anything that treats them as different sites
    counts one job as three."""
    assert len({
        hosts.vendor_of("https://boards.greenhouse.io/a/jobs/1"),
        hosts.vendor_of("https://job-boards.greenhouse.io/a/jobs/1"),
        hosts.vendor_of("https://job-boards.eu.greenhouse.io/a/jobs/1"),
    }) == 1


# ---- boards belong to their own adapters ------------------------------------

def test_boards_are_never_web_discovery_results():
    for url in [
        "https://www.linkedin.com/jobs/view/1",
        "https://uk.linkedin.com/jobs/view/1",
        "https://in.indeed.com/viewjob?jk=a",
        "https://www.naukri.com/job-listings-x",
        "https://internshala.com/internship/detail/x",
        "https://unstop.com/internships/x",
        "https://www.glassdoor.co.in/job/x",
        "https://wellfound.com/jobs/1-intern",
    ]:
        assert hosts.classify(url) == "board", url
        assert not hosts.is_useful(url)


def test_a_regional_twin_goes_with_its_parent():
    """A suffix-match list of .com names let every regional twin straight
    through — which is how a Glassdoor link survived the first live filter."""
    assert hosts.classify("https://www.glassdoor.co.in/job/x") == "board"
    assert hosts.classify("https://in.indeed.com/viewjob") == "board"


# ---- mirrors: named, and unnamed ------------------------------------------

def test_the_mirrors_from_the_live_run_are_rejected():
    """Every one of these outranked a real employer in a measured run."""
    for host in ["alexahire.in", "vthetecheejobs.com", "hellointern.in",
                 "www.jobgrid.in", "www.internshiphub.org", "www.antaltechjobs.in",
                 "beincareer.com", "www.ambitionbox.com", "web3.career"]:
        url = f"https://{host}/some-internship-2026"
        assert hosts.classify(url) == "aggregator", url
        assert not hosts.is_useful(url)


def test_a_mirror_nobody_wrote_down_is_still_rejected():
    """The point of shape-matching: these domains are invented, and a denylist
    would pass every one of them."""
    for host in ["freshersjobalert.in", "internshipvacancy.com",
                 "govtjobscareer.org", "offcampushiring.in", "placementjobs.co.in"]:
        assert hosts.classify(f"https://{host}/x-intern") == "aggregator", host


def test_one_job_word_is_not_enough_to_condemn_a_company():
    """Two distinct job-board words are required, or a real employer whose name
    happens to contain "hire" or "job" would be thrown away."""
    for host in ["hirect.com", "jobsforher.com", "careem.com", "internetbrands.com"]:
        assert hosts.classify(f"https://{host}/careers/intern") != "aggregator", host


# ---- employer-owned, and unknown -------------------------------------------

def test_a_companys_own_careers_path_is_employer_owned():
    for url in ["https://acme.com/careers/intern-2026",
                "https://www.acme.io/jobs/ml-intern",
                "https://careers.acme.co.in/openings/data-intern"]:
        assert hosts.classify(url) == "employer", url
        assert hosts.is_trusted(url)


def test_a_google_form_counts_as_the_employers_own_intake():
    """Outside an ATS, a Form is where India student internships actually live."""
    assert hosts.classify("https://docs.google.com/forms/d/e/1FA/viewform") == "employer"


def test_an_unrecognised_host_is_kept_but_not_trusted():
    """A small employer on a domain nobody has seen is exactly the listing the
    boards miss. Keeping it costs a ranking slot; dropping it costs the job."""
    url = "https://somestartup.xyz/2026-summer-programme"
    assert hosts.classify(url) == "unknown"
    assert hosts.is_useful(url)
    assert not hosts.is_trusted(url)


def test_registrable_domain_handles_two_label_suffixes():
    assert hosts.registrable("careers.acme.co.in") == "acme"
    assert hosts.registrable("acme.com") == "acme"
    assert hosts.registrable("jobs.acme.co.uk") == "acme"


def test_a_junk_url_is_never_useful():
    for url in ["", "not a url", "mailto:a@b.com"]:
        assert not hosts.is_useful(url)
