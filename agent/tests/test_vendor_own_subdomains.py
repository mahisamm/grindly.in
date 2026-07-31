"""A vendor's own hostname is not one of its customers.

Adding `site:keka.com` to discovery (Keka being the highest-yield vendor
measured) immediately returned Keka's own marketing pages —
www.keka.com/glossary/intern, www.keka.com/hr-intern-job-description,
academy.keka.com — and the subdomain pattern read "www" and "academy" as
company names. Both were learned as boards and polled on every subsequent run,
each a guaranteed miss, logging "keka/www: no org id in the portal info".
"""
import atsboards


def test_the_vendors_own_marketing_hostnames_are_not_companies():
    urls = [
        "https://www.keka.com/glossary/intern",
        "https://www.keka.com/hr-intern-job-description",
        "https://academy.keka.com/careers/",
        "https://blog.keka.com/internships",
        "https://help.keka.com/careers",
    ]
    assert atsboards.slugs_from_urls(urls) == set()


def test_a_real_keka_tenant_is_still_learned():
    """The exclusion must not cost us the boards that actually pay."""
    found = atsboards.slugs_from_urls([
        "https://vyaparapp.keka.com/careers/jobdetails/123",
        "https://comprinno.keka.com/careers/",
    ])
    assert ("keka", "vyaparapp") in found
    assert ("keka", "comprinno") in found


def test_the_same_reserved_words_are_refused_across_vendors():
    """These hostnames are generic; every vendor has them."""
    assert atsboards.slugs_from_urls(["https://www.workable.com/pricing"]) == set()
    assert atsboards.slugs_from_urls(["https://app.workable.com/x"]) == set()


def test_real_boards_on_other_vendors_are_unaffected():
    found = atsboards.slugs_from_urls([
        "https://boards.greenhouse.io/cloudsek",
        "https://jobs.lever.co/meesho",
        "https://jobs.ashbyhq.com/ramp",
        "https://apply.workable.com/thirdco/",
    ])
    assert ("greenhouse", "cloudsek") in found
    assert ("lever", "meesho") in found
    assert ("ashby", "ramp") in found
    assert ("workable", "thirdco") in found


def test_the_existing_structural_words_still_hold():
    """Regression guard for the original _NOT_A_SLUG entries."""
    for word in ("embed", "jobs", "api", "widget", "posting-api"):
        assert word in atsboards._NOT_A_SLUG
