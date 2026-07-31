"""Both halves of scoring must read the same posting.

The keyword pass was widened to 6000 characters precisely because a real
posting's masthead, cookie notice and "about us" fill the first stretch of the
page while the requirements section naming the stack sits well below it. The
semantic pass kept its own 1200-character cut, so it was computed against the
least informative part of every page — the exact boilerplate the other window
exists to get past.
"""
import matcher


def _posting(boilerplate_chars: int, requirements: str) -> str:
    """A page shaped like the real ones: a wall of company blurb, then the
    part that actually names the technology."""
    filler = ("We are a fast growing company. Our culture is our strength. "
              "Read about our benefits, our offices and our values. ")
    head = (filler * ((boilerplate_chars // len(filler)) + 1))[:boilerplate_chars]
    return head + " " + requirements


REQS = ("Requirements: strong python, pytorch and computer vision. "
        "You will train deep learning models and ship them.")
SKILLS = "python pytorch computer vision deep learning"


def test_the_window_is_shared_with_the_keyword_pass():
    assert matcher._JD_WINDOW == 6000


def test_requirements_below_the_old_cut_are_now_read():
    """Buried at 3000 characters — past the old 1200, inside the new 6000."""
    jd = _posting(3000, REQS)
    assert matcher._tfidf_score(SKILLS, jd) > 0.0


def test_a_deeply_buried_requirements_section_beats_boilerplate_alone():
    buried = matcher._tfidf_score(SKILLS, _posting(3000, REQS))
    none_at_all = matcher._tfidf_score(SKILLS, _posting(3000, "We value teamwork."))
    assert buried > none_at_all, "reading further found nothing extra"


def test_an_irrelevant_posting_still_scores_lower_than_a_relevant_one():
    relevant = matcher._tfidf_score(SKILLS, _posting(500, REQS))
    irrelevant = matcher._tfidf_score(
        SKILLS, _posting(500, "Requirements: cold calling, CRM hygiene, quota attainment."))
    assert relevant > irrelevant


def test_the_score_stays_within_bounds():
    for jd in ("", _posting(200, REQS), _posting(9000, REQS)):
        v = matcher._tfidf_score(SKILLS, jd)
        assert 0.0 <= v <= 1.0


def test_empty_input_is_zero_not_an_error():
    assert matcher._tfidf_score("", "anything") == 0.0
    assert matcher._tfidf_score("anything", "") == 0.0


def test_a_missing_sklearn_degrades_to_keywords_rather_than_failing(monkeypatch):
    """A run must never die because an optional dependency is absent."""
    import builtins

    real_import = builtins.__import__

    def _no_sklearn(name, *a, **k):
        if name.startswith("sklearn"):
            raise ImportError("not installed")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _no_sklearn)
    assert matcher._tfidf_score(SKILLS, _posting(100, REQS)) == 0.0
    score, _ = matcher.score_job(
        {"title": "ML Intern", "company": "Acme", "skills": ["python"]},
        ["python"], ["Machine Learning"], exp_level="student", jd_text=REQS,
    )
    assert score > 0
