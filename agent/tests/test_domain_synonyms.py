"""Employers name the job, not the taxonomy.

Measured live during the supply probe: a real "Data Science Intern" scored 0
for a candidate whose chosen domains include Machine Learning and whose skills
name machine learning, deep learning and computer vision — because no employer
writes "Machine Learning Intern" when they mean a data scientist.

The opposite failure matters just as much: this must not become the loose
token-overlap test it replaced, which handed the domain bonus to every
"<Anything> Development Internship".
"""
import matcher


def _hit(domain: str, text: str) -> bool:
    hay = matcher._norm(text)
    return matcher._domain_hit([domain], hay, matcher._tokens(hay))


# --- the synonyms fire -------------------------------------------------------

def test_data_science_counts_as_machine_learning():
    assert _hit("Machine Learning", "Data Science Intern")


def test_the_measured_case_now_scores():
    """The exact listing from the probe: title only, no description."""
    job = {"title": "Data Science Intern", "company": "Zypp Electric", "skills": []}
    score, _ = matcher.score_job(
        job, ["python", "machine learning", "deep learning"],
        ["Machine Learning", "Artificial Intelligence"], exp_level="intern",
    )
    assert score > 0, "a data science internship still reads as irrelevant"


def test_a_range_of_real_listing_titles_reach_their_field():
    for domain, title in [
        ("Machine Learning", "Computer Vision Intern"),
        ("Machine Learning", "NLP Engineer Intern"),
        ("Artificial Intelligence", "Generative AI Intern"),
        ("Web Development", "Full Stack Developer Intern"),
        ("Web Development", "Backend Intern"),
        ("Frontend Development", "React Developer Internship"),
        ("Mobile Development", "Android Intern"),
        ("Mobile Development", "Flutter Developer Intern"),
        ("UI/UX Design", "Product Design Intern"),
        ("DevOps", "Site Reliability Intern"),
        ("Cyber Security", "SOC Analyst Intern"),
    ]:
        assert _hit(domain, title), f"{title!r} did not reach {domain!r}"


def test_the_exact_domain_name_still_works():
    assert _hit("Machine Learning", "Machine Learning Intern")
    assert _hit("Web Development", "Web Development Internship")


# --- and do not fire for everything ------------------------------------------

def test_an_unrelated_listing_gets_no_bonus():
    for domain, title in [
        ("Machine Learning", "HR Intern"),
        ("Machine Learning", "B2B Sales Intern"),
        ("Machine Learning", "Finance Trainee"),
        ("Web Development", "Content Writing Intern"),
        ("Mobile Development", "Marketing Intern"),
        ("UI/UX Design", "Operations Intern"),
    ]:
        assert not _hit(domain, title), f"{title!r} wrongly counted as {domain!r}"


def test_a_multi_word_synonym_never_fires_on_one_of_its_words():
    """The regression that made this test file necessary in the first place:
    "Science Intern" is not data science, and "Data Entry" is not either."""
    assert not _hit("Machine Learning", "Science Intern")
    assert not _hit("Machine Learning", "Data Entry Intern")
    assert not _hit("Mobile Development", "App Store Marketing Intern")
    assert not _hit("Web Development", "Stack Overflow Community Intern")


def test_a_domain_with_no_synonyms_still_behaves():
    assert _hit("Robotics", "Robotics Intern")
    assert not _hit("Robotics", "HR Intern")


def test_no_domains_means_no_hit():
    hay = matcher._norm("Data Science Intern")
    assert not matcher._domain_hit([], hay, matcher._tokens(hay))
