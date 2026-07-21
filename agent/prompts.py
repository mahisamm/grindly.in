"""Prompt version registry.

Every LLM-facing task in the agent has a stable name and a version stamp here.
When a prompt's wording changes, bump its version — the eval harness
(agent/eval_llm.py) records the registry fingerprint with each run, so a quality
regression can be traced to the exact prompt revision that caused it. Without
this, "the matcher got worse last week" has no anchor; with it, the eval report
names the prompt and version under test.

This is a registry, not the prompt bodies — the bodies live at their call sites
where the surrounding schema logic is. The registry is the audit + drift index.
"""
from __future__ import annotations

import hashlib

# name -> {version, purpose}. Bump `version` (date-stamped) on any wording change.
PROMPT_REGISTRY: dict[str, dict[str, str]] = {
    "skills.extract": {
        "version": "2026-07-21",
        "purpose": "resume text -> concrete hireable skill list",
    },
    "resume.analyze": {
        "version": "2026-07-21",
        "purpose": "resume text -> quality score + improvement suggestions",
    },
    "resume.tailor": {
        "version": "2026-07-21",
        "purpose": "master resume -> role-tailored LaTeX edits",
    },
    "resume.optimize.extract": {
        "version": "2026-07-21",
        "purpose": "resume text -> template-agnostic structured JSON",
    },
    "resume.optimize.rewrite": {
        "version": "2026-07-21",
        "purpose": "structured resume + ATS strategy -> higher-scoring rewrite (no fabrication)",
    },
    "questions.answer": {
        "version": "2026-07-21",
        "purpose": "screening question -> answer grounded in the candidate's resume",
    },
    "cover.letter": {
        "version": "2026-07-21",
        "purpose": "job + resume -> short tailored cover letter",
    },
}


def version(name: str) -> str:
    """Version string for a registered prompt. Raises on an unknown name so a
    typo can't silently evaluate an untracked prompt."""
    return PROMPT_REGISTRY[name]["version"]


def registry_fingerprint() -> str:
    """Short stable hash of every prompt name+version. Changes iff any prompt
    version changes — the single value an eval run tags itself with to prove
    which prompt set produced its metrics."""
    payload = ";".join(f"{name}={meta['version']}" for name, meta in sorted(PROMPT_REGISTRY.items()))
    return hashlib.sha256(payload.encode()).hexdigest()[:12]
