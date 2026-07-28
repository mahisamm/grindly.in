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
