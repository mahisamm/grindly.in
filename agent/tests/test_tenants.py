"""Finding the employers on a multi-tenant ATS.

Two enumeration routes that look obviously correct were measured and are dead,
and the reasons are asserted here so nobody rebuilds them:

  * Certificate Transparency. Keka serves ONE wildcard certificate, so no tenant
    ever appears in a CT log. Three tenants from our own production pool —
    comprinno, ketto, evolve — are absent from crt.sh entirely.
  * DNS. `*.keka.com` is a wildcard record, so a made-up label resolves to the
    same address as a real customer and a lookup proves nothing.

What works is a public web index: ask Common Crawl which `*.keka.com/careers*`
URLs it has actually seen, and the hostname of each one is a real tenant.
Measured: 445 tenants against 53 previously known, at zero cost to any employer.

These tests cover the parsing, because that is where this quietly breaks — a
mis-parse does not fail loudly, it adds a board that 404s on every poll forever.
"""
import json

import pytest

import tenants


# ── the tenant is pulled out of the right part of the URL ─────────────────

def test_a_subdomain_vendor_takes_the_tenant_from_the_host():
    assert tenants._tenant_of("https://convertcart.keka.com/careers/", "keka") == "convertcart"


def test_a_path_vendor_takes_the_tenant_from_the_first_segment():
    assert tenants._tenant_of("https://jobs.lever.co/scaler/abc-123", "lever") == "scaler"
    assert tenants._tenant_of("https://boards.greenhouse.io/stripe", "greenhouse") == "stripe"


def test_a_deep_careers_url_still_yields_the_tenant():
    got = tenants._tenant_of(
        "https://analyticsvidhya.keka.com/careers/jobdetails/12345", "keka")
    assert got == "analyticsvidhya"


# ── the vendor's own hosts are not employers ──────────────────────────────

def test_the_vendors_own_subdomains_are_not_treated_as_customers():
    """Measured on the real crt.sh answer for keka.com: help, apidocs, academy,
    developers and explore are all Keka's own. Polled as boards they are a
    guaranteed 404 per run, forever."""
    for host in ("help", "apidocs", "academy", "developers", "www", "explore",
                 "status", "login", "demo"):
        assert tenants._tenant_of(f"https://{host}.keka.com/careers/", "keka") is None, host


def test_a_mis_parsed_slug_is_rejected():
    """The live failure this guards: 'Ouro%20Careers%20Page' and 'oops' both
    reached the learned-board list and cost one 404 per poll for as long as they
    stayed on it."""
    assert tenants._tenant_of("https://boards.greenhouse.io/Ouro%20Careers", "greenhouse") is None
    assert tenants._tenant_of("https://jobs.lever.co/", "lever") is None


def test_a_url_that_is_not_a_url_does_not_raise():
    for junk in ("", "not a url", "http://", "///"):
        assert tenants._tenant_of(junk, "keka") is None


# ── parsing a crawl response ──────────────────────────────────────────────

def _index_payload(urls):
    return "\n".join(json.dumps({"url": u}) for u in urls)


def test_tenants_are_deduplicated_across_many_pages_of_one_company(monkeypatch):
    """A busy employer has hundreds of indexed job pages. They are one board."""
    monkeypatch.setattr(tenants, "_get", lambda *a, **k: _index_payload([
        "https://codingal.keka.com/careers/jobdetails/1",
        "https://codingal.keka.com/careers/jobdetails/2",
        "https://codingal.keka.com/careers/",
        "https://infilect.keka.com/careers/jobdetails/9",
    ]))
    assert tenants.from_crawl("keka", "CC-MAIN-2026-30") == {"codingal", "infilect"}


def test_a_malformed_line_does_not_lose_the_rest_of_the_page(monkeypatch):
    monkeypatch.setattr(tenants, "_get", lambda *a, **k: "\n".join([
        json.dumps({"url": "https://getambee.keka.com/careers/"}),
        "{not json at all",
        "",
        json.dumps({"url": "https://applify.keka.com/careers/"}),
    ]))
    assert tenants.from_crawl("keka", "CC-MAIN-2026-30") == {"getambee", "applify"}


def test_an_unknown_vendor_returns_nothing_rather_than_guessing(monkeypatch):
    monkeypatch.setattr(tenants, "_get", lambda *a, **k: _index_payload(
        ["https://x.notavendor.com/careers/"]))
    assert tenants.from_crawl("notavendor", "CC-MAIN-2026-30") == set()


# ── a gateway error is a transport failure, not an empty answer ───────────

def test_a_gateway_error_is_retried_not_reported_as_zero(monkeypatch):
    """Measured over ten crawls in one run: three answered and seven returned
    502/504. Without retry the sweep reported 59 tenants; with it, 445. Treating
    a 504 as 'this crawl has none' silently under-reports by a factor of eight."""
    import urllib.error

    calls = {"n": 0}

    def flaky(url, timeout=90):
        calls["n"] += 1
        if calls["n"] < 3:
            raise urllib.error.HTTPError(url, 504, "Gateway Timeout", {}, None)
        return _index_payload(["https://nurix.keka.com/careers/"])

    monkeypatch.setattr(tenants, "_get", flaky)
    monkeypatch.setattr(tenants.time, "sleep", lambda *_: None)
    assert tenants.from_crawl("keka", "CC-MAIN-2026-30") == {"nurix"}
    assert calls["n"] == 3


def test_a_404_means_this_crawl_has_none_and_is_not_retried(monkeypatch):
    """404 is a real answer from the index, not a failure — retrying it just
    spends someone else's capacity to be told the same thing again."""
    import urllib.error

    calls = {"n": 0}

    def missing(url, timeout=90):
        calls["n"] += 1
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    monkeypatch.setattr(tenants, "_get", missing)
    monkeypatch.setattr(tenants.time, "sleep", lambda *_: None)
    assert tenants.from_crawl("keka", "CC-MAIN-2026-30") == set()
    assert calls["n"] == 1


def test_retries_are_eventually_given_up_on(monkeypatch):
    import urllib.error

    def always_down(url, timeout=90):
        raise urllib.error.HTTPError(url, 503, "Service Unavailable", {}, None)

    monkeypatch.setattr(tenants, "_get", always_down)
    monkeypatch.setattr(tenants.time, "sleep", lambda *_: None)
    assert tenants.from_crawl("keka", "CC-MAIN-2026-30", attempts=3) == set()


def test_a_network_error_is_survived(monkeypatch):
    def boom(url, timeout=90):
        raise OSError("connection reset")

    monkeypatch.setattr(tenants, "_get", boom)
    monkeypatch.setattr(tenants.time, "sleep", lambda *_: None)
    assert tenants.from_crawl("keka", "CC-MAIN-2026-30", attempts=2) == set()


# ── handing the result to the board poller ────────────────────────────────

def test_slugs_become_urls_the_existing_learner_can_parse():
    """Deliberately goes through atsboards.remember_slugs rather than writing
    the learned-board file directly: that function owns the plausibility check,
    the size cap and the atomic write, and a second writer is how the file ends
    up corrupt."""
    import atsboards

    urls = tenants.board_urls("keka", {"convertcart", "codingal"})
    assert len(urls) == 2
    assert atsboards.slugs_from_urls(urls) >= {("keka", "convertcart"), ("keka", "codingal")}


def test_every_supported_vendor_can_be_turned_back_into_a_url():
    for vendor in tenants._PATTERNS:
        urls = tenants.board_urls(vendor, {"acme"})
        assert urls, vendor
        assert "acme" in urls[0]


def test_a_url_built_here_round_trips_back_to_the_same_tenant():
    """The parse and the build must agree, or the enumerator learns boards under
    names the poller then cannot find."""
    for vendor in tenants._PATTERNS:
        url = tenants.board_urls(vendor, {"convertcart"})[0]
        assert tenants._tenant_of(url, vendor) == "convertcart", vendor


# ── the crawl list ────────────────────────────────────────────────────────

def test_crawls_are_newest_first_and_bounded(monkeypatch):
    """Newest first because a tenant seen only in a 2019 crawl has more likely
    churned off the platform, and the request budget should go where the hit
    rate is highest."""
    monkeypatch.setattr(tenants, "_get", lambda *a, **k: json.dumps(
        [{"id": f"CC-MAIN-2026-{n:02d}"} for n in (30, 25, 21, 17, 12)]))
    assert tenants.crawls(3) == ["CC-MAIN-2026-30", "CC-MAIN-2026-25", "CC-MAIN-2026-21"]


def test_a_broken_crawl_list_yields_no_crawls_rather_than_raising(monkeypatch):
    monkeypatch.setattr(tenants, "_get", lambda *a, **k: "not json")
    assert tenants.crawls(5) == []
