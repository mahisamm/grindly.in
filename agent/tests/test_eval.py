"""Tests for the LLM eval harness (agent/eval_llm.py) and prompt registry."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import eval_llm
import prompts


def _perfect_extractor(resume: str) -> list[str]:
    """Return every token that could match, so recall is 1.0 — proves the
    harness credits correct extraction."""
    low = resume.lower()
    vocab = [
        "react", "typescript", "node", "express", "postgresql", "docker",
        "python", "pandas", "numpy", "scikit-learn", "tensorflow", "flask",
        "java", "spring", "kafka", "redis", "kubernetes", "aws",
        "flutter", "dart", "next.js", "firebase",
    ]
    return [v for v in vocab if v in low]


def _broken_extractor(_resume: str) -> list[str]:
    return ["soft skills", "teamwork"]


def test_perfect_extractor_scores_full_recall():
    cases = eval_llm.load_cases()["skills"]
    report = eval_llm.evaluate_skills(_perfect_extractor, cases)
    assert report["recall"] == 1.0
    assert report["n"] == len(cases)


def test_broken_extractor_fails_the_gate():
    report = eval_llm.run(extract_fn=_broken_extractor, min_recall=0.75)
    assert report["passed"] is False
    assert report["skills"]["recall"] < 0.75


def test_good_extractor_passes_the_gate_and_tags_fingerprint():
    report = eval_llm.run(extract_fn=_perfect_extractor, min_recall=0.75)
    assert report["passed"] is True
    assert report["prompt_fingerprint"] == prompts.registry_fingerprint()


def test_recall_is_substring_tolerant():
    hits, misses = eval_llm._recall(["node.js", "react"], ["node", "react", "docker"])
    assert hits == 2
    assert misses == ["docker"]


def test_registry_fingerprint_changes_with_version(monkeypatch):
    before = prompts.registry_fingerprint()
    patched = {**prompts.PROMPT_REGISTRY, "skills.extract": {"version": "9999-01-01", "purpose": "x"}}
    monkeypatch.setattr(prompts, "PROMPT_REGISTRY", patched)
    assert prompts.registry_fingerprint() != before


def test_version_lookup_rejects_unknown_prompt():
    import pytest

    with pytest.raises(KeyError):
        prompts.version("does.not.exist")
