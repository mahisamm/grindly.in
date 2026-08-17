"""The curated packs, held to the rules the module docstring sets out.

A pack is the strong version of targeting: every claim in one is something the
employer published, with the URL and the date a person read it. That promise is
printed on the page next to the packs, so it has to be enforced by something
other than the good intentions of whoever adds the next company.

What these tests cannot check is whether a URL still resolves — that needs the
network, and a test suite that fails because someone else's marketing site was
being redeployed is a test suite people learn to ignore. Link rot is handled by
`curated_on` being visible in the UI, so a stale pack looks stale.
"""
from __future__ import annotations

import re
from datetime import date

import pytest

import companies

PACKS = companies.PACKS


def test_there_are_packs_and_no_duplicates():
    assert len(PACKS) >= 10
    slugs = [p.slug for p in PACKS]
    assert len(slugs) == len(set(slugs)), "two packs share a slug"
    names = [p.name.lower() for p in PACKS]
    assert len(names) == len(set(names)), "two packs share a name"


@pytest.mark.parametrize("pack", PACKS, ids=lambda p: p.slug)
class TestEveryPack:
    def test_the_slug_is_url_safe_and_lowercase(self, pack):
        assert re.fullmatch(r"[a-z0-9-]+", pack.slug), pack.slug

    def test_it_carries_at_least_one_source(self, pack):
        assert pack.sources, "a pack with no source is a guess with a logo on it"

    def test_every_source_is_an_https_url_with_a_claim(self, pack):
        for s in pack.sources:
            assert s.url.startswith("https://"), s.url
            # Long enough to be a statement rather than a label.
            assert len(s.claim) >= 40, s.claim
            assert s.claim.rstrip().endswith("."), s.claim

    def test_every_source_is_dated_and_not_from_the_future(self, pack):
        for s in pack.sources:
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", s.curated_on), s.curated_on
            assert date.fromisoformat(s.curated_on) <= date.today(), s.curated_on

    def test_the_source_points_at_the_company_not_at_a_third_party(self, pack):
        """A pack's evidence must be the employer's own words.

        A Glassdoor thread or a coaching blog is exactly the class of source
        this product refuses to launder into a claim, and it would sit under the
        same "open it and check" promise as everything else here.
        """
        banned = (
            "glassdoor.", "reddit.", "quora.", "medium.com", "linkedin.com/pulse",
            "indeed.com", "ambitionbox.", "naukri.", "geeksforgeeks.", "leetcode.",
            "youtube.com", "wikipedia.org",
        )
        for s in pack.sources:
            low = s.url.lower()
            assert not any(b in low for b in banned), f"{pack.slug}: third-party source {s.url}"

    def test_it_says_something_specific(self, pack):
        assert 40 <= len(pack.summary) <= 400, pack.summary
        assert 2 <= len(pack.emphasis) <= 6, pack.slug
        assert 4 <= len(pack.keywords) <= 20, pack.slug
        assert pack.best_for, pack.slug

    def test_no_emphasis_line_tells_anyone_to_claim_anything(self, pack):
        """The one rule that cannot bend.

        Emphasis says what to SURFACE from a resume. A line that says "add",
        "mention that you have", or "if you don't have" is an instruction to
        fabricate — the downstream gates would strip the result, but the variant
        is wasted and the user is told their resume is missing something we made
        up.
        """
        banned = re.compile(
            r"\b(?:add|include|insert|claim|invent|fabricate)\b"
            r"|\bmention that you have\b|\bsay that you\b|\bif you don'?t have\b"
            r"|\beven if\b|\bpretend\b",
            re.I,
        )
        for line in pack.emphasis:
            assert not banned.search(line), f"{pack.slug}: {line!r}"

    def test_emphasis_lines_are_sentences_not_slogans(self, pack):
        for line in pack.emphasis:
            assert 30 <= len(line) <= 260, f"{pack.slug}: {line!r}"

    def test_keywords_are_search_terms_not_sentences(self, pack):
        for kw in pack.keywords:
            assert kw == kw.lower(), f"{pack.slug}: {kw!r} is not lowercase"
            assert 1 <= len(kw.split()) <= 3, f"{pack.slug}: {kw!r} is a phrase"
            # One character is allowed: "c" is a language three packs list, and
            # `readiness._skill_present` matches on token boundaries, so it does
            # not fire on the letter c inside another word.
            assert 1 <= len(kw) <= 40, f"{pack.slug}: {kw!r}"
        assert len(pack.keywords) == len(set(pack.keywords)), pack.slug


# ---------------------------------------------------------------------------
# lookup
# ---------------------------------------------------------------------------

def test_get_pack_is_case_and_whitespace_tolerant():
    for typed in ("amazon", "Amazon", "  AMAZON  ", "AmAzOn"):
        assert companies.get_pack(typed) is not None, typed
    assert companies.get_pack("not-a-company") is None
    assert companies.get_pack("") is None


def test_search_matches_slug_and_name():
    assert any(p["slug"] == "tcs" for p in companies.search("tcs"))
    assert any(p["slug"] == "tcs" for p in companies.search("Tata"))
    assert any(p["slug"] == "adobe" for p in companies.search("adobe"))
    assert companies.search("zzzzz") == []
    # An empty query is a browse, not a failed search.
    assert len(companies.search("")) == len(PACKS)


def test_the_disclaimer_disclaims_the_things_that_matter():
    low = companies.DISCLAIMER.lower()
    for phrase in ("not affiliated", "endorsed", "trademarks"):
        assert phrase in low, phrase


def test_to_dict_round_trips_for_the_api():
    import json
    payload = json.dumps(companies.list_packs())
    back = json.loads(payload)
    assert len(back) == len(PACKS)
    assert all(isinstance(p["sources"][0], dict) for p in back)
