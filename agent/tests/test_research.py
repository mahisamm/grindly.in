"""Targeting a company with no curated pack.

The behaviour under test is mostly the refusal. A language model asked "how does
company X hire" always produces fluent, confident, plausible text — for a
forty-person startup it has never heard of just as readily as for Amazon. So
these tests are weighted toward the answers that must NOT come out: a generated
pack with two lines of generic resume advice, an emphasis line that tells
someone to claim something, a confident answer about a company the model does
not know.
"""
from __future__ import annotations

import json

import pytest

import company_research
import llm as llm_mod


@pytest.fixture
def answer(monkeypatch):
    """Pin the providers' replies so these tests measure our filtering.

    Stubbed at `chat_ensemble`, which returns RAW STRINGS — the same boundary
    the real code calls — rather than at a helper that hands back a finished
    dict. That distinction is the whole reason this fixture looks like this.

    The first version stubbed `chat_json_ensemble`, which merges the providers'
    answers before returning. Every test passed and the feature was broken in
    production for every company: the merge keeps only list items a majority of
    models produce verbatim, so `emphasis` and `keywords` came back empty and
    every lookup declined. The stub had replaced the exact code that was
    failing. A test double belongs at the edge of the system, not in the middle
    of the logic under test.

    `payloads` may be one dict or a list of them, so a test can give the two
    providers different answers — which is the real situation and the one that
    broke.
    """
    def _set(payloads):
        answers = payloads if isinstance(payloads, list) else [payloads, payloads]

        def fake(prompt, system="", n=2, timeout=60, **kw):
            return [json.dumps(a) for a in answers[:max(1, n)]]

        monkeypatch.setattr(llm_mod, "chat_ensemble", fake)
        monkeypatch.setattr(company_research.llm_mod, "chat_ensemble", fake)
    return _set


GOOD = {
    "known": True,
    "confidence": 0.85,
    "canonical_name": "Freshworks Inc.",
    "size": "large",
    "summary": "Screens for SaaS product engineering with an emphasis on customer-facing "
               "software and a published multi-round interview process.",
    "emphasis": [
        "Lead with product work that shipped to external customers rather than internal tooling.",
        "Name the SaaS stack your projects used — the postings list specific frameworks.",
        "Show ownership of a feature end to end, from spec through support.",
    ],
    "keywords": ["saas", "java", "python", "react", "rest api", "product engineering"],
}


# ---------------------------------------------------------------------------
# the three outcomes
# ---------------------------------------------------------------------------

def test_a_curated_pack_wins_and_never_reaches_the_model(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("the model was called for a company we have a pack for")
    monkeypatch.setattr(company_research.llm_mod, "chat_ensemble", explode)

    for typed in ("amazon", "Amazon", "AMAZON", "Tata Consultancy Services"):
        out = company_research.research(typed)
        assert out["tailoring"] == "curated", typed
        assert out["sources"], "a curated pack must carry its sources"


def test_a_well_known_company_produces_a_labelled_generated_pack(answer):
    answer(GOOD)
    out = company_research.research("Freshworks")
    assert out["tailoring"] == "generated"
    assert out["name"] == "Freshworks Inc."
    assert len(out["emphasis"]) == 3
    assert "saas" in out["keywords"]
    # The label is not optional. A generated pack that reads like a curated one
    # is the failure this whole module is shaped around.
    assert "not curated" in out["note"].lower()
    assert "not affiliated" in out["disclaimer"].lower()
    assert not out.get("sources"), "a generated pack must not claim sources"


def test_declining_is_a_successful_answer_not_an_error(answer):
    answer({"known": False, "confidence": 0.0})
    out = company_research.research("Kalyani Fabricators")
    assert out["ok"] is True
    assert out["tailoring"] == "not_required"
    assert out["emphasis"] == [] and out["keywords"] == []
    # It must say WHY, name the company, and point somewhere useful.
    assert "Kalyani Fabricators" in out["note"]
    assert "job posting" in out["note"] or "job description" in out["note"]


def test_no_model_configured_declines_rather_than_erroring(monkeypatch):
    def dead(*a, **k):
        raise RuntimeError("no provider configured")
    monkeypatch.setattr(company_research.llm_mod, "chat_ensemble", dead)

    out = company_research.research("Some Company Ltd")
    assert out["ok"] is True
    assert out["tailoring"] == "not_required"
    # The user is not shown an outage. They get the same answer a small company
    # would have produced anyway, which is the truthful one either way.
    assert "outage" not in out["note"].lower()
    assert "error" not in out["note"].lower()


# ---------------------------------------------------------------------------
# two providers, two different answers — the case that shipped broken
# ---------------------------------------------------------------------------

def test_providers_that_word_it_differently_still_produce_a_pack(answer):
    """The regression test for the bug that made this feature never work.

    Two models asked how Tesla screens resumes both answer well and neither
    writes the same sentence as the other. Merging their answers by majority
    vote — which is what `chat_json_ensemble` does — keeps only the list items
    they produced VERBATIM, so `emphasis` and `keywords` came back empty and
    every company declined. Measured live: provider A gave 4 lines and 10
    keywords, provider B gave 3 and 10, the merge gave 0 and 0.

    Consensus is the wrong tool for a question whose answer is prose. Whole
    responses, best one wins.
    """
    a = {
        "known": True, "confidence": 0.8, "canonical_name": "Tesla, Inc.",
        "summary": "Hires heavily into powertrain, autonomy and manufacturing software.",
        "emphasis": [
            "Lead with embedded or control-systems work over general web experience.",
            "Name the languages your firmware and tooling used, especially C++ and Python.",
            "Surface anything that shipped into a physical product or a factory.",
        ],
        "keywords": ["c++", "python", "embedded", "autonomy", "manufacturing"],
    }
    b = {
        "known": True, "confidence": 1.0, "canonical_name": "Tesla",
        "summary": "Screens for hands-on engineering depth and shipped hardware or vehicle software.",
        "emphasis": [
            "Put vehicle, battery or energy work at the top of the page.",
            "Show ownership of something that reached production rather than a prototype.",
            "State the scale you worked at — units, vehicles, sites.",
            "Name the simulation and test tooling your projects used.",
        ],
        "keywords": ["electric vehicles", "battery", "c++", "simulation", "controls"],
    }
    answer([a, b])

    out = company_research.research("telsa")
    assert out["tailoring"] == "generated", (
        "two good answers that disagree on wording must not cancel each other out"
    )
    # The richest SURVIVING answer wins — b has four lines to a's three.
    assert len(out["emphasis"]) == 4
    assert "battery" in out["keywords"]


def test_the_typo_is_answered_about_the_real_company(answer):
    """Someone types "telsa". The card said "Tesla, Inc." over a sentence about
    how "telsa" screens resumes — two names for one company on one card."""
    answer({"known": False, "confidence": 0.0, "canonical_name": "Tesla, Inc."})
    out = company_research.research("telsa")
    assert out["name"] == "Tesla, Inc."
    assert "Tesla, Inc." in out["note"]
    assert "telsa" not in out["note"]


def test_one_junk_response_does_not_sink_a_good_one(answer):
    """Providers fail independently. One returning nothing usable must not stop
    the other's answer from being used."""
    answer([{"known": False, "confidence": 0.0}, GOOD])
    assert company_research.research("Freshworks")["tailoring"] == "generated"


def test_unparseable_output_is_skipped_not_crashed_on(monkeypatch):
    monkeypatch.setattr(
        company_research.llm_mod, "chat_ensemble",
        lambda *a, **k: ["not json at all", None, json.dumps(GOOD)],
    )
    out = company_research.research("Freshworks")
    assert out["ok"] is True
    assert out["tailoring"] == "generated"


# ---------------------------------------------------------------------------
# overriding a confident model
# ---------------------------------------------------------------------------

def test_a_confident_answer_with_nothing_in_it_is_still_declined(answer):
    answer({
        "known": True, "confidence": 0.95, "canonical_name": "Acme Pvt Ltd",
        "summary": "Acme hires talented people who are passionate about technology.",
        "emphasis": ["Tailor your resume to the role.", "Quantify your achievements."],
        "keywords": [],
    })
    out = company_research.research("Acme Pvt Ltd")
    assert out["tailoring"] == "not_required", (
        "generic advice plus no vocabulary means the model does not know this "
        "company, whatever its confidence flag says"
    )


def test_low_confidence_is_declined_even_when_the_content_looks_good(answer):
    answer({**GOOD, "confidence": 0.3})
    assert company_research.research("Freshworks")["tailoring"] == "not_required"


def test_a_single_emphasis_line_is_not_a_pack(answer):
    answer({**GOOD, "emphasis": GOOD["emphasis"][:1]})
    assert company_research.research("Freshworks")["tailoring"] == "not_required"


def test_emphasis_that_instructs_a_claim_is_stripped(answer):
    answer({**GOOD, "emphasis": GOOD["emphasis"] + [
        "Add cloud certifications to your skills section if you don't have them.",
        "Mention that you have experience leading distributed teams.",
        "Claim familiarity with their internal platform.",
    ]})
    out = company_research.research("Freshworks")
    assert out["tailoring"] == "generated"
    joined = " ".join(out["emphasis"]).lower()
    for banned in ("if you don't have", "mention that you have", "claim familiarity"):
        assert banned not in joined
    assert len(out["emphasis"]) == 3


def test_generic_resume_advice_is_stripped_from_emphasis(answer):
    answer({**GOOD, "emphasis": [
        "Tailor your resume to the job description.",
        "Proofread carefully before submitting.",
        *GOOD["emphasis"],
    ]})
    out = company_research.research("Freshworks")
    assert len(out["emphasis"]) == 3
    assert not any(e.lower().startswith(("tailor", "proofread")) for e in out["emphasis"])


def test_keywords_are_bounded_and_deduplicated(answer):
    answer({**GOOD, "keywords": [
        "SaaS", "saas", "SAAS",
        "a very long phrase that is really a sentence and not a keyword at all",
        "x", "", None, *[f"kw{i}" for i in range(20)],
    ]})
    out = company_research.research("Freshworks")
    assert len(out["keywords"]) <= 12
    assert out["keywords"].count("saas") == 1
    assert all(len(k.split()) <= 4 for k in out["keywords"])


# ---------------------------------------------------------------------------
# input handling
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("typed", ["", "   ", "\t\n"])
def test_an_empty_name_is_rejected(typed):
    assert company_research.research(typed)["ok"] is False


def test_an_absurdly_long_name_is_rejected():
    assert company_research.research("x" * 200)["ok"] is False


def test_whitespace_is_normalised_before_matching(monkeypatch):
    monkeypatch.setattr(
        company_research.llm_mod, "chat_ensemble",
        lambda *a, **k: pytest.fail("should have matched the curated pack"),
    )
    out = company_research.research("  amazon  ")
    assert out["tailoring"] == "curated"
