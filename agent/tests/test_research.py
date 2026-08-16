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

import pytest

import company_research
import llm as llm_mod


@pytest.fixture
def answer(monkeypatch):
    """Pin the model's reply so these tests measure our filtering, not its mood."""
    def _set(payload):
        monkeypatch.setattr(
            llm_mod, "chat_json_ensemble",
            lambda *a, **k: payload,
        )
        monkeypatch.setattr(
            company_research.llm_mod, "chat_json_ensemble",
            lambda *a, **k: payload,
        )
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
    monkeypatch.setattr(company_research.llm_mod, "chat_json_ensemble", explode)

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
    monkeypatch.setattr(company_research.llm_mod, "chat_json_ensemble", dead)

    out = company_research.research("Some Company Ltd")
    assert out["ok"] is True
    assert out["tailoring"] == "not_required"
    # The user is not shown an outage. They get the same answer a small company
    # would have produced anyway, which is the truthful one either way.
    assert "outage" not in out["note"].lower()
    assert "error" not in out["note"].lower()


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
        company_research.llm_mod, "chat_json_ensemble",
        lambda *a, **k: pytest.fail("should have matched the curated pack"),
    )
    out = company_research.research("  amazon  ")
    assert out["tailoring"] == "curated"
