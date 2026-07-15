"""Resume intelligence beyond "an LLM liked it".

The ATS check is mechanical on purpose. It is not an opinion about the writing; it
is a test of what a machine can actually pull out of the file — which is all a
recruiter's system ever sees, and the one failure that silently sinks every single
application while looking perfect to a human.
"""
import matcher
import resume_ai


GOOD = (
    "Mahendhar Sammeta  |  m@example.com  |  +91 98765 43210\n"
    "B.Tech CSE, Anurag University, CGPA 8.4\n"
    "SKILLS: python, react, node, sql, docker\n"
    "PROJECTS: Built Grindly, an agent that applies to internships, using Python "
    "and React. Deployed with Docker on a VPS, cutting manual applying to zero.\n"
)
SKILLS = ["python", "react", "node", "sql", "docker"]


# --- the failure that looks perfect to a human ------------------------------

def test_a_resume_no_parser_can_read_is_flagged_hard():
    """A scanned or image-based PDF looks flawless on screen and is a blank page to
    an ATS. Nothing else in the analysis matters if this is true."""
    r = resume_ai.ats_report("", SKILLS)
    assert r["readable"] is False
    assert r["warnings"]
    assert "cannot read" in r["warnings"][0].lower()


def test_an_unreadable_resume_cannot_score_well_however_good_the_prose():
    """An LLM shown the text would happily call it an 88. It is not an 88 — no human
    will ever see it."""
    pretty = {"score": 88, "grade": "A", "strengths": [], "issues": [], "suggestions": []}
    out = resume_ai.with_ats(pretty, "", SKILLS)
    assert out["score"] <= 35
    assert out["grade"] in ("D", "F")


def test_a_readable_resume_keeps_its_score():
    good = {"score": 82, "grade": "B", "strengths": [], "issues": [], "suggestions": []}
    out = resume_ai.with_ats(good, GOOD, SKILLS)
    assert out["score"] == 82
    assert out["ats"]["readable"] is True


def test_ats_problems_are_listed_before_style_suggestions():
    """They are hard failures, not polish. A user who reads one line should read the
    one that says a machine can't open their file."""
    base = {"score": 70, "grade": "B", "strengths": [],
            "issues": ["Add more action verbs"], "suggestions": []}
    out = resume_ai.with_ats(base, "too short", SKILLS)
    assert "cannot read" in out["issues"][0].lower()


def test_a_missing_email_is_caught():
    text = GOOD.replace("m@example.com", "")
    r = resume_ai.ats_report(text, SKILLS)
    assert any("email" in w.lower() for w in r["warnings"])


def test_skills_that_do_not_survive_extraction_are_caught():
    """Skills inside a graphic or a two-column table vanish on extraction. The
    resume looks full; the parser sees none of the keywords it shortlists on."""
    text = "Mahendhar  m@example.com  +91 98765 43210  " + "Experienced engineer. " * 20
    r = resume_ai.ats_report(text, SKILLS)
    assert any("findable" in w.lower() for w in r["warnings"])


def test_a_clean_resume_raises_no_warnings():
    assert resume_ai.ats_report(GOOD, SKILLS)["warnings"] == []


# --- the gap report ---------------------------------------------------------
# "You scored 72" tells a candidate nothing they can act on.

def test_it_names_what_the_role_wants_and_the_candidate_lacks():
    job = {"title": "DevOps Intern", "skills": ["docker", "kubernetes", "aws"]}
    gap = matcher.missing_skills(job, ["python", "docker"])
    assert "kubernetes" in gap and "aws" in gap
    assert "docker" not in gap          # they have it


def test_it_never_reports_a_gap_the_candidate_has_covered():
    job = {"title": "Frontend Intern", "skills": ["react", "javascript"]}
    assert matcher.missing_skills(job, ["react", "javascript", "css"]) == []


def test_it_agrees_with_the_scorer_about_what_counts_as_a_hit():
    """Both sides use the same alias table, so "React JS" on a listing and
    "javascript" on a resume must not be a hit for one and a gap for the other."""
    job = {"title": "React JS Intern", "skills": ["js"]}
    assert matcher.missing_skills(job, ["javascript"]) == []


def test_the_jd_is_read_for_requirements_the_listing_card_never_declared():
    """Internshala cards routinely declare no skills at all — the real requirements
    are only in the description."""
    job = {"title": "Backend Intern", "skills": []}
    jd = "You will work with Kubernetes and PostgreSQL on our platform team."
    gap = matcher.missing_skills(job, ["python"], jd_text=jd)
    assert "kubernetes" in gap


def test_the_gap_list_stays_short_enough_to_act_on():
    job = {"title": "X", "skills": [
        "kubernetes", "aws", "azure", "gcp", "terraform", "ansible", "jenkins", "go",
    ]}
    assert len(matcher.missing_skills(job, ["python"])) <= 6
