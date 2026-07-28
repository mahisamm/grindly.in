import os
import sys

# Make the agent modules importable as top-level (matcher, safety, ...) in tests.
sys.path.insert(0, os.path.dirname(__file__))

# Role-title generation asks a language model. A test suite that reaches a live
# provider is slow, nondeterministic and fails on someone else's rate limit —
# and this one did exactly that. The deterministic ladder it falls back to is a
# complete implementation, so tests exercise that; the model half is covered by
# tests that stub the provider explicitly.
os.environ.setdefault("GRINDLY_ROLE_QUERIES_LLM", "0")

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated_learned_boards(tmp_path, monkeypatch):
    """Give every test its own set of learned ATS boards.

    atsboards remembers company slugs on the shared data volume so a company
    found once is polled directly from then on — deliberately process-wide and
    deliberately persistent, which makes it exactly the kind of state that leaks
    between tests. One test's discovery must not decide another's board list.
    """
    try:
        import atsboards
    except Exception:  # noqa: BLE001 — a test module that never imports it
        return
    monkeypatch.setattr(atsboards, "_LEARNED", set(), raising=False)
    monkeypatch.setattr(atsboards, "_learned_loaded", True, raising=False)
    monkeypatch.setattr(atsboards, "_LEARNED_FILE",
                        str(tmp_path / "ats_slugs.json"), raising=False)
