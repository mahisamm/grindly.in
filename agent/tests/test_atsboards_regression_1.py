"""Regression tests for ATS-board discovery failures found during QA."""

import atsboards


def test_current_indian_internship_does_not_depend_on_removed_stale_word_list():
    # Regression: ATS-board discovery crashed because it referenced
    # websource._STALE_WORDS after that fixed-year list was replaced.
    # Found by /qa on 2026-07-27.
    assert atsboards._wanted({
        "title": "Software Engineering Intern",
        "location": "Bengaluru, India",
        "jd": "Applications are open for the 2026 program.",
    })
