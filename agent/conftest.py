"""Pytest configuration for the agent package.

Two jobs, and the second is a safety rail rather than a convenience:

  1. Put `agent/` on sys.path, because every module imports its peers by bare
     name (`import readiness`) and pytest's rootdir is the repo root.

  2. Pin the LLM providers away from the network for the whole suite. A test
     whose result depends on what a model says today is not a test — it is a
     flake that fails on someone else's machine and passes on the author's. The
     previous build learned this the expensive way with its vision provider: a
     key in `.env` meant every image test posted real photographs to a real
     endpoint, and the suite ran three times slower and failed at random.

     Clearing the keys is done by env var rather than by monkeypatching the
     module, so it holds even for code that reads `os.environ` at call time and
     for a subprocess the test spawns.
"""
from __future__ import annotations

import os
import sys

import pytest

_AGENT_DIR = os.path.dirname(os.path.abspath(__file__))
if _AGENT_DIR not in sys.path:
    sys.path.insert(0, _AGENT_DIR)

# Every provider key llm.py knows about. Listed explicitly rather than derived
# from llm.PROVIDERS so importing llm is not a precondition for the suite being
# safe — if the import itself ever hits the network, the pin must already be on.
_PROVIDER_KEYS = (
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "CEREBRAS_API_KEY",
    "MISTRAL_API_KEY",
)


@pytest.fixture(autouse=True, scope="session")
def _no_network_llm():
    saved = {k: os.environ.pop(k, None) for k in _PROVIDER_KEYS}
    # Redaction is on by default in production; keep it on here so a test that
    # inspects an outbound prompt sees what a provider would really receive.
    os.environ.setdefault("GRINDLY_REDACT_PII", "1")
    yield
    for key, value in saved.items():
        if value is not None:
            os.environ[key] = value
