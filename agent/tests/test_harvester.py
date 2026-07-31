"""Growing the board index.

Measured before this module was written (agent/supply_probe.py): guessing slugs
from company names hits 2% because a slug is not a company name
(caterpillar.keka.com is Group Bayport), while search-harvested boards yield 27x
more per board tested. Keka returned 10 India internships to Greenhouse's 0
across 563 postings. Those two facts are what the harvester's shape encodes.
"""
from unittest.mock import patch

import atsboards
import harvester


# --- the round trip that would otherwise fail silently ----------------------

def test_every_vendor_url_round_trips_back_to_its_own_slug():
    """remember_slugs takes URLs and re-derives the slug. A URL shape its
    patterns do not recognise learns NOTHING, silently, forever."""
    for vendor in harvester._VENDOR_HOSTS:
        url = harvester._url_for(vendor, "acmecorp")
        assert url, f"no URL shape for {vendor}"
        pairs = atsboards.slugs_from_urls([url])
        assert (vendor, "acmecorp") in pairs, f"{vendor}: {url} did not round-trip"


def test_an_unknown_vendor_yields_no_url_rather_than_a_broken_one():
    assert harvester._url_for("workday", "acme") == ""


# --- query budget -----------------------------------------------------------

def test_the_query_budget_is_capped():
    """One IP fronts every search. A sweep that gets it rate-limited takes the
    only working discovery path down with it."""
    qs = harvester.queries()
    assert len(qs) <= harvester.MAX_QUERIES
    assert qs, "no queries at all"


def test_keka_earns_more_of_the_budget_than_greenhouse():
    """The budget follows measured yield, not brand."""
    qs = harvester.queries()
    keka = sum(1 for q in qs if "keka" in q)
    gh = sum(1 for q in qs if "greenhouse" in q)
    assert keka > gh, f"keka={keka} greenhouse={gh}"


def test_every_query_is_site_scoped():
    assert all(q.startswith("site:") for q in harvester.queries())


# --- candidates -------------------------------------------------------------

def test_boards_already_known_are_not_candidates_again():
    known_slug = next(iter(atsboards.BOARDS["greenhouse"]))
    urls = [f"https://boards.greenhouse.io/{known_slug}"]
    assert harvester.candidates(urls) == []


def test_an_implausible_slug_is_refused():
    """Live, a mis-parse produced "Ouro%20Careers%20Page", costing one 404 per
    board poll for as long as it stayed on the list."""
    urls = ["https://boards.greenhouse.io/Ouro%20Careers%20Page"]
    assert harvester.candidates(urls) == []


def test_a_new_board_is_a_candidate_exactly_once():
    urls = ["https://boards.greenhouse.io/verynewcompany"] * 3
    assert harvester.candidates(urls) == [("greenhouse", "verynewcompany")]


# --- validation -------------------------------------------------------------

def test_a_board_with_no_postings_is_never_learned():
    """A dead slug costs one request on every future run, and the thing that
    notices only runs AFTER the board has been polled and failed."""
    with patch.object(atsboards, "_get_json", return_value={"jobs": []}), \
         patch.object(atsboards, "_postings", return_value=[]):
        assert harvester.validate([("greenhouse", "empty")]) == []


def test_a_board_with_postings_is_kept():
    with patch.object(atsboards, "_get_json", return_value={"jobs": [{"id": 1}]}), \
         patch.object(atsboards, "_postings", return_value=[{"title": "Intern"}]):
        assert harvester.validate([("greenhouse", "real")]) == [("greenhouse", "real")]


def test_a_board_is_kept_even_with_no_internship_today():
    """A company that hires interns in September has none in July. Dropping it
    now means never seeing September's."""
    with patch.object(atsboards, "_get_json", return_value={"jobs": [{"id": 1}]}), \
         patch.object(atsboards, "_postings",
                      return_value=[{"title": "Senior Backend Engineer"}]):
        assert harvester.validate([("greenhouse", "seasonal")]) == [("greenhouse", "seasonal")]


def test_a_board_that_raises_is_dropped_not_fatal():
    with patch.object(atsboards, "_get_json", side_effect=RuntimeError("boom")):
        assert harvester.validate([("greenhouse", "broken")]) == []


def test_validating_nothing_is_harmless():
    assert harvester.validate([]) == []


# --- the sweep itself -------------------------------------------------------

def test_a_dry_run_never_writes_to_the_index():
    with patch.object(harvester, "_search_all", return_value=["https://boards.greenhouse.io/newco"]), \
         patch.object(harvester, "validate", return_value=[("greenhouse", "newco")]), \
         patch.object(atsboards, "remember_slugs") as remember:
        result = harvester.sweep(dry_run=True)
    remember.assert_not_called()
    assert result["validated"] == 1
    assert result["learned"] == 0


def test_a_real_sweep_learns_what_it_validated():
    with patch.object(harvester, "_search_all", return_value=["https://boards.greenhouse.io/newco"]), \
         patch.object(harvester, "validate", return_value=[("greenhouse", "newco")]), \
         patch.object(atsboards, "remember_slugs", return_value=1) as remember:
        result = harvester.sweep()
    remember.assert_called_once()
    assert result["learned"] == 1
    # It must hand over a URL its own parser recognises, not a raw pair.
    handed = remember.call_args[0][0]
    assert atsboards.slugs_from_urls(handed) == {("greenhouse", "newco")}


def test_a_sweep_with_no_search_backend_still_returns_a_result():
    with patch.object(harvester, "_search_all", return_value=[]):
        result = harvester.sweep(dry_run=True)
    assert result["candidates"] == 0
    assert result["learned"] == 0
