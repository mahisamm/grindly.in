"""Offline-capable eval harness for the agent's LLM pipeline.

Two jobs:
  1. Score the pipeline against a small golden set (agent/eval/cases.json) and
     produce a recall metric plus a hard threshold gate — so a prompt or model
     change that quietly degrades skill extraction fails loudly instead of
     shipping.
  2. Tag every run with the prompt-registry fingerprint (agent/prompts.py), so a
     metric drop is always traceable to the exact prompt revision under test.

Runs WITHOUT live API keys: pass any `extract_fn` (a fake in tests, the real
`resume_parse.extract_skills` in CI/live). The harness never calls a provider
itself — it evaluates whatever function it's given. That keeps it deterministic
in tests and honest in production.

CLI:
    python agent/eval_llm.py            # uses resume_parse.extract_skills
    python agent/eval_llm.py --min 0.8  # custom gate; exits 1 if below
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Callable

import prompts

CASES_PATH = os.path.join(os.path.dirname(__file__), "eval", "cases.json")
DEFAULT_MIN_RECALL = 0.75


def load_cases(path: str = CASES_PATH) -> dict:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def _recall(found: list[str], expected: list[str]) -> tuple[int, list[str]]:
    """Count how many expected skills appear in `found` (case-insensitive,
    substring-tolerant so 'node' matches 'node.js'). Returns (hits, misses)."""
    low = [str(f).lower() for f in found]
    hits = 0
    misses: list[str] = []
    for want in expected:
        w = want.lower()
        if any(w in f or f in w for f in low):
            hits += 1
        else:
            misses.append(want)
    return hits, misses


def evaluate_skills(extract_fn: Callable[[str], list[str]], cases: list[dict]) -> dict:
    """Run `extract_fn` over each skills case, return aggregate + per-case recall."""
    per_case = []
    total_expected = 0
    total_hits = 0
    for case in cases:
        expected = case["expect_any"]
        found = extract_fn(case["resume"]) or []
        hits, misses = _recall(found, expected)
        total_expected += len(expected)
        total_hits += hits
        per_case.append(
            {
                "recall": hits / len(expected) if expected else 1.0,
                "misses": misses,
                "found": list(found),
            }
        )
    recall = total_hits / total_expected if total_expected else 1.0
    return {"recall": recall, "cases": per_case, "n": len(cases)}


def run(extract_fn: Callable[[str], list[str]] | None = None, min_recall: float = DEFAULT_MIN_RECALL) -> dict:
    """Full eval report. `extract_fn` defaults to the real extractor (needs keys
    to be meaningful); tests inject a deterministic fake."""
    if extract_fn is None:
        import resume_parse

        extract_fn = resume_parse.extract_skills
    cases = load_cases()
    skills_report = evaluate_skills(extract_fn, cases["skills"])
    passed = skills_report["recall"] >= min_recall
    return {
        "prompt_fingerprint": prompts.registry_fingerprint(),
        "min_recall": min_recall,
        "skills": skills_report,
        "passed": passed,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Grindly LLM eval harness")
    parser.add_argument("--min", type=float, default=DEFAULT_MIN_RECALL, help="minimum skill recall to pass")
    args = parser.parse_args(argv)
    report = run(min_recall=args.min)
    print(json.dumps(report, indent=2, ensure_ascii=False))
    print(
        f"[eval] prompt set {report['prompt_fingerprint']} · "
        f"skill recall {report['skills']['recall']:.2f} "
        f"(gate {report['min_recall']:.2f}) · {'PASS' if report['passed'] else 'FAIL'}"
    )
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    raise SystemExit(main())
