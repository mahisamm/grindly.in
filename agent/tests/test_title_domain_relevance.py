"""A title naming the candidate's own field is evidence, not decoration.

Measured live: Zypp Electric published a "Data Science Intern" role with a
119-character description. Keyword overlap has nothing to find in that page, so
an ML candidate scored 12 on a role written for them — while a 6000-character
"B2B Sales intern" correctly scored 0. Length is not quality, and a title is
the one place an employer always states the subject of the job.

The floor must not become a way for a bare title to outrank a real match.
"""
import matcher


ML = ["python", "machine learning", "deep learning", "computer vision"]
DOMAINS = ["Machine Learning", "Artificial Intelligence"]


def _score(title, skills=ML, domains=DOMAINS, jd="", job_skills=None):
    job = {"title": title, "company": "Acme", "skills": job_skills or []}
    return matcher.score_job(job, skills, domains, exp_level="student", jd_text=jd)


def test_the_measured_case_now_clears_the_threshold():
    """The whole reason this exists: a real data science internship, an ML
    candidate, and a description too short to say anything."""
    score, _ = _score("Data Science Intern", jd="Data Science Intern at Zypp.")
    assert score >= 65, f"scored {score}; an ML candidate would never see this role"


def test_a_bare_title_never_outranks_a_listing_naming_the_real_stack():
    bare, _ = _score("Data Science Intern")
    named, _ = _score(
        "Data Science Intern",
        jd="You will use python, deep learning and computer vision daily.",
        job_skills=["python", "deep learning", "computer vision"],
    )
    assert named > bare, "reading the description stopped being worth anything"


def test_an_out_of_field_title_gets_no_floor():
    for title in ("HR Intern", "B2B Sales Intern", "Finance Trainee",
                  "Content Writing Intern", "Operations Intern"):
        score, _ = _score(title)
        assert score < 65, f"{title!r} scored {score} for an ML candidate"


def test_a_long_irrelevant_description_still_scores_low():
    """Length is not quality — the sales listing had 5532 characters."""
    jd = ("We are looking for a B2B Sales intern to join our growth team. "
          "You will call prospects, manage the pipeline and close deals. " * 40)
    score, _ = _score("B2B Sales intern", jd=jd)
    assert score < 65


def test_the_reason_names_the_real_evidence():
    """A user reading "weak skill overlap" next to a score of 67 has been
    told the opposite of what happened."""
    _, reason = _score("Data Science Intern")
    assert "weak skill overlap" not in reason
    assert "field" in reason


def test_a_listing_that_names_skills_still_reads_as_a_skill_match():
    _, reason = _score(
        "Data Science Intern",
        jd="python and machine learning required",
        job_skills=["python", "machine learning"],
    )
    assert reason.startswith("matches ")


def test_no_domains_means_no_floor():
    score, _ = _score("Data Science Intern", domains=[])
    assert score < 65


def test_the_floor_never_lowers_a_strong_match():
    """max(), not assignment — a listing at full relevance must be untouched."""
    strong = {"title": "Machine Learning Intern", "company": "Acme",
              "skills": ["python", "machine learning", "deep learning"]}
    score, _ = matcher.score_job(
        strong, ML, DOMAINS, exp_level="student",
        jd_text="python machine learning deep learning computer vision",
    )
    assert score >= 90
