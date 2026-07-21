"""email_scanner must only ever write Outcome-enum-valid values.

Regression cover for the bug where the classifier could emit "test" (a coding
assessment) and the scanner wrote it straight to applications.outcome — a value
the Prisma Outcome enum didn't define, which throws on Postgres and corrupts the
column on SQLite.
"""
import os
import re

import email_scanner


def _prisma_outcome_values() -> set[str]:
    """The values actually declared in `enum Outcome { ... }` in the schema."""
    schema = os.path.join(os.path.dirname(__file__), "..", "..", "prisma", "schema.prisma")
    text = open(schema, encoding="utf-8").read()
    block = re.search(r"enum Outcome \{(.*?)\}", text, re.S).group(1)
    return {
        line.strip()
        for line in block.splitlines()
        if line.strip() and not line.strip().startswith("//")
    }


def test_test_outcome_is_persistable():
    # "test" is a real, enum-valid intermediate outcome the scanner writes.
    assert "test" in email_scanner.PERSISTED_OUTCOMES


def test_non_enum_labels_are_never_persisted():
    # These would throw on the Postgres enum / corrupt the SQLite column.
    for junk in ("no_response", "unrelated", "ghosted", ""):
        assert junk not in email_scanner.PERSISTED_OUTCOMES


def test_persisted_outcomes_are_a_subset_of_the_schema_enum():
    # Drift guard: everything the scanner writes must exist in the Prisma enum.
    assert email_scanner.PERSISTED_OUTCOMES <= _prisma_outcome_values()


def test_schema_enum_defines_test():
    # The other half of the fix: the enum must actually carry "test".
    assert "test" in _prisma_outcome_values()


def test_keyword_fallback_detects_a_coding_test():
    # With no LLM providers configured, classify_email falls back to keywords;
    # an assessment email should classify as "test", which is now persistable.
    out = email_scanner.classify_email(
        "Acme", "Backend Intern",
        "Your coding assessment", "Please complete the HackerRank test to proceed.",
    )
    assert out["outcome"] == "test"
