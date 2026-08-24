"""The written review — "A recruiter's read".

This file exists because the feature shipped broken and nothing caught it.
`advise()` merged three providers' answers with `chat_json_ensemble`, which
keeps only the list items a majority produced VERBATIM. Skill lists survive
that; ADVICE does not, because three models never write the same sentence. So
the merge returned empty lists on every call and the function fell through to
its heuristic fallback — under a panel that tells the user they are reading a
model's opinion of their writing.

Measured on production before the fix: providers returned 3, 3 and 4 strengths,
3, 4 and 4 issues, and 5 suggestions each; the merge returned
{"strengths": [], "issues": [], "suggestions": []}.

Everything here stubs `chat_ensemble`, which returns RAW STRINGS — the boundary
the real code calls. A double placed any further in would have hidden the bug
again.
"""
from __future__ import annotations

import json

import pytest

import llm as llm_mod
import resume_ai

RESUME = """Rohit Verma
+91 99887 76655 | rohit.verma@example.com | Hyderabad, India

EXPERIENCE
Senior Data Engineer, Northline Retail | Feb 2022 - Present
- Rebuilt the nightly ETL in Python and Airflow, cutting the run from 7 hours to 90 minutes
- Migrated 120 tables from MySQL to Snowflake with zero reported data loss

EDUCATION
B.Tech Information Technology, JNTU Hyderabad | 2015 - 2019
"""


def _advice(n: int, tag: str) -> dict:
    """A well-formed review, worded uniquely so no two providers agree."""
    return {
        "strengths": [f"{tag}: every bullet names the tool it used" for _ in range(1)]
        + [f"{tag}: the numbers are specific and checkable"],
        "issues": [f"{tag}: no profile link a reviewer can open"][:n],
        "suggestions": [
            f"{tag}: write the GitHub URL out as text rather than behind a hyperlink",
            f"{tag}: give the Snowflake migration a line on what it unblocked",
        ][:n],
    }


@pytest.fixture
def providers(monkeypatch):
    def _set(payloads):
        def fake(prompt, system="", n=3, timeout=60, **kw):
            return [None if p is None else (p if isinstance(p, str) else json.dumps(p))
                    for p in payloads[:max(1, n)]]
        monkeypatch.setattr(llm_mod, "chat_ensemble", fake)
        monkeypatch.setattr(resume_ai.llm_mod, "chat_ensemble", fake)
    return _set


def test_differently_worded_reviews_do_not_cancel_each_other_out(providers):
    """The regression test. Three good answers, no two alike, must produce a
    review — not the fallback."""
    providers([_advice(1, "A"), _advice(2, "B"), _advice(1, "C")])
    out = resume_ai.advise(RESUME)

    joined = " ".join(out["strengths"] + out["issues"] + out["suggestions"])
    assert any(tag in joined for tag in ("A:", "B:", "C:")), (
        "advise() returned the heuristic fallback while three providers had answered"
    )
    assert out["suggestions"], "a review with no suggestions is not a review"


def test_the_fullest_review_wins(providers):
    providers([_advice(1, "thin"), _advice(2, "full"), _advice(1, "thin2")])
    out = resume_ai.advise(RESUME)
    joined = " ".join(out["issues"] + out["suggestions"])
    assert "full:" in joined
    # The GitHub suggestion is intentionally removed because this fixture does
    # not state that the candidate has a GitHub profile.
    assert len(out["suggestions"]) == 1


def test_one_bad_response_does_not_lose_a_good_one(providers):
    providers(["not json at all", None, _advice(2, "good")])
    out = resume_ai.advise(RESUME)
    assert "good:" in " ".join(out["suggestions"])


def test_a_response_with_no_substance_is_not_used(providers):
    """Empty lists are what the broken merge produced. They must not be
    mistaken for a review."""
    providers([{"strengths": [], "issues": [], "suggestions": []}])
    out = resume_ai.advise(RESUME)
    assert out["suggestions"], "an empty answer should have fallen back"
    assert not any("strengths" in s for s in out["suggestions"])


def test_no_provider_falls_back_with_the_right_shape(monkeypatch):
    monkeypatch.setattr(resume_ai.llm_mod, "chat_ensemble", lambda *a, **k: [])
    out = resume_ai.advise(RESUME)
    assert set(out) == {"strengths", "issues", "suggestions", "source"}
    assert out["source"] == "heuristic"
    assert all(isinstance(out[k], list) for k in ("strengths", "issues", "suggestions"))
    assert out["suggestions"], "the fallback must still say something useful"


def test_a_provider_that_raises_is_not_an_error(monkeypatch):
    def dead(*a, **k):
        raise RuntimeError("all providers down")
    monkeypatch.setattr(resume_ai.llm_mod, "chat_ensemble", dead)
    out = resume_ai.advise(RESUME)
    assert set(out) == {"strengths", "issues", "suggestions", "source"}
    assert out["source"] == "heuristic"


def test_empty_input_does_not_reach_a_provider(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("a provider was called for an empty resume")
    monkeypatch.setattr(resume_ai.llm_mod, "chat_ensemble", explode)
    out = resume_ai.advise("")
    assert set(out) == {"strengths", "issues", "suggestions", "source"}
    assert out["source"] == "heuristic"


def test_the_review_never_carries_a_number(providers):
    """The panel's promise: the score is arithmetic and this is not it. A model
    that returns a score anyway must have it dropped."""
    payload = {**_advice(2, "X"), "score": 82, "grade": "B", "rating": 7}
    providers([payload])
    out = resume_ai.advise(RESUME)
    assert set(out) == {"strengths", "issues", "suggestions", "source"}
    assert out["source"] == "model"


def test_the_fallback_does_not_assume_a_student(monkeypatch):
    """This product is for anyone applying for a job. The fallback used to tell
    a data engineer with five years of experience what belongs "on a fresher
    resume"."""
    monkeypatch.setattr(resume_ai.llm_mod, "chat_ensemble", lambda *a, **k: [])
    out = resume_ai.advise(RESUME)
    text = " ".join(out["strengths"] + out["issues"] + out["suggestions"]).lower()
    for word in ("fresher", "campus", "placement", "college student"):
        assert word not in text, f"the fallback assumes a student: {word!r}"
