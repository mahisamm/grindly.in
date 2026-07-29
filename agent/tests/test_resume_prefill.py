"""Setup should ask for what a resume does NOT say — and nothing else.

The owner's first run through setup had them typing in their own name, phone,
CGPA, degree, college, graduation year and class 12 percentage. Every one of
those was written on the resume they had just uploaded. Two faults caused it:
the extractor never looked for name or the board percentages, and the form
fetched the profile once on page load while the worker was still reading.

This pins the first half. A field here is one the candidate should be CHECKING.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import resume_ai


RESUME = """Mahendhar Sammeta
Hyderabad, India | 8096267553 | mahendhar@example.com
linkedin.com/in/mahendhar-sammeta | github.com/mahisamm | mahendhar.dev

EDUCATION
Anurag University - B.Tech in Computer Science (AI & ML), CGPA: 7.55
Expected graduation 2027
Class 12 (Intermediate): 94%
Class 10 (SSC): 91.5%

SKILLS
Python, TypeScript, Docker, Playwright
"""


def _c(text=RESUME):
    return resume_ai.extract_contact(text, this_year=2026)


def test_the_candidates_own_name_is_read_off_the_top():
    # Never extracted before. It is the single most-asked field on any form, and
    # a Google account with no name left the user typing it by hand.
    assert _c()["name"] == "Mahendhar Sammeta"


def test_the_board_percentages_are_read():
    # Asked by most Indian internship forms, supplied by no other field — the
    # college CGPA is a different number entirely.
    c = _c()
    assert c["class12_percent"] == 94.0
    assert c["class10_percent"] == 91.5


def test_everything_else_still_comes_through():
    c = _c()
    assert c["phone"] == "8096267553"
    assert c["gpa"] == 7.55
    assert c["grad_year"] == 2027
    assert "B.Tech" in (c["degree"] or "")
    assert "Anurag University" in (c["college"] or "")
    assert "linkedin.com/in/mahendhar-sammeta" in (c["linkedin_url"] or "")
    assert "github.com/mahisamm" in (c["github_url"] or "")


def test_a_portfolio_link_is_not_the_github_link():
    # linkedin.com and github.com both end in a TLD the portfolio pattern
    # accepts; without the guard one link lands in two boxes.
    c = _c()
    assert c["portfolio_url"] == "mahendhar.dev"


def test_a_percentage_that_is_not_a_school_result_is_ignored():
    # "improved throughput by 94%" is not a board mark, and a wrong number here
    # is typed into a real eligibility box as fact.
    text = "Rahul Verma\nBuilt a pipeline that improved throughput by 94% over six weeks.\n"
    c = resume_ai.extract_contact(text, this_year=2026)
    assert c["class12_percent"] is None
    assert c["class10_percent"] is None


def test_a_cgpa_written_against_class_12_is_not_read_as_a_percentage():
    text = "Priya Nair\nClass 12 - 9.4 CGPA\n"
    assert resume_ai.extract_contact(text, this_year=2026)["class12_percent"] is None


def test_a_job_title_at_the_top_is_not_mistaken_for_a_name():
    # Plenty of resumes lead with a headline. Filing "Software Engineer" as the
    # candidate's name would put it on every application.
    text = "Software Engineer\nCurriculum Vitae\nAsha Rao\nasha@example.com\n"
    assert resume_ai.extract_contact(text, this_year=2026)["name"] == "Asha Rao"


def test_nothing_is_invented_from_an_empty_resume():
    c = resume_ai.extract_contact("", this_year=2026)
    assert set(v for v in c.values() if v is not None) == set()
