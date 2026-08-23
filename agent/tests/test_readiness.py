"""The scorer is the product's one number. These tests are its contract.

Two properties matter more than any individual threshold:

  * Determinism. `score()` must be a pure function. If it ever depends on a
    clock, a provider, or a dict iteration order, every "this rewrite is 11
    points better" claim the product makes becomes a lie, and nothing else in
    the test suite would catch it.

  * Ordering. A worse resume must score lower than a better one. Absolute values
    can be re-tuned; the ranking is what the user actually experiences.
"""
from __future__ import annotations

import readiness


# --------------------------------------------------------------------------
# fixtures — deliberately written as literal resumes, not as mock objects
# --------------------------------------------------------------------------

# A realistic full-length one-page resume, not a compressed sample. The first
# version of this fixture was 748 characters with five bullets, which tripped
# the "very short" and "only 5 bullets" findings — so assertions about a strong
# resume were really being made against a thin one, and two of them failed for
# reasons that had nothing to do with the code under test.
STRONG = """PRIYA SHARMA
Hyderabad, India | +91 98765 43210 | priya.sharma@example.com | github.com/priyasharma | linkedin.com/in/priyasharma

EDUCATION
B.Tech in Computer Science and Engineering
Anurag University, Hyderabad | Aug 2022 - May 2026 | CGPA: 8.4/10

EXPERIENCE
Software Engineering Intern, Zenlytics Pvt Ltd
Jun 2025 - Aug 2025
- Built a REST API in FastAPI and PostgreSQL that served 12000 daily requests for the internal analytics dashboard
- Reduced median query latency from 840ms to 190ms by adding Redis caching and rewriting three N+1 queries
- Wrote 46 pytest cases covering the billing module, raising coverage from 31% to 78%

Web Development Intern, Anurag Innovation Cell
Jan 2025 - Apr 2025
- Developed the college placement portal front end in React and Tailwind, used by 1400 students
- Automated resume collection with a Python script, saving the placement team roughly 6 hours per week

PROJECTS
DriveSense - Driver drowsiness detection
- Trained a MobileNetV2 classifier in PyTorch on 8000 labelled frames, reaching 94% validation accuracy
- Deployed the model to a Raspberry Pi 4 with OpenCV, achieving 22 FPS on device

CampusMart - Peer to peer marketplace
- Built a Next.js and MongoDB marketplace with Razorpay payments, onboarding 300 students in the first month
- Implemented JWT auth and role based access control

TECHNICAL SKILLS
Languages: Python, JavaScript, TypeScript, Java, SQL, C
Frameworks: FastAPI, Django, React, Next.js, Node.js, PyTorch
Tools: Docker, Git, PostgreSQL, MongoDB, Redis, Linux, AWS

ACHIEVEMENTS
- 1st place, Anurag Hackathon 2025 among 62 teams
- Google Cloud Associate Cloud Engineer, certified Mar 2025
"""

SCANNED = "Priya Sharma\nResume\n"

PROSE = """Rahul Verma
rahul.verma@example.com

I am a final year student and I am passionate about technology. I was
responsible for various tasks during my internship where I worked on several
projects. I am a detail-oriented and self-motivated person looking for an
opportunity to leverage my skills. During college I worked on many different
assignments and successfully completed all of them effectively and efficiently.
"""

DUTIES = """AMIT KUMAR
amit.kumar@example.com

EDUCATION
B.Tech Computer Science, VIT Vellore, Aug 2022 - May 2026

SKILLS
Python, Java, HTML, CSS

PROJECTS
Chat Application
- Responsible for building a chat app
- Worked on the front end and back end
- Used various technologies
"""

# A realistic two-column extraction, not a nine-line sketch. The first version
# of this fixture produced only four qualifying lines — one below the evidence
# floor — so the honest options were to lower the floor to fit the toy or to
# make the fixture look like the thing it represents. A real two-column resume
# interleaves for thirty lines, so this one does.
TWO_COLUMN = """SNEHA RAO                                        EXPERIENCE
sneha@example.com                                Business Analyst Intern, Acme Corp
+91 90000 00000                                  Jun 2024 - Aug 2024
Delhi, India                                     Built internal reporting tools daily
                                                 Wrote documentation for two APIs
SKILLS                                           Fixed defects in the billing service
Python                                           Presented findings to the team
SQL                                              Marketing Intern, Bluebird Media
Excel                                            Jan 2024 - Apr 2024
Tableau                                          Ran the weekly campaign report
Power BI                                         Managed the content calendar
                                                 Analysed channel performance data
LANGUAGES                                        EDUCATION
English                                          B.Com Honours, Delhi University
Hindi                                            Aug 2022 - May 2025
Tamil                                            Percentage 82.4 across three years
                                                 Higher Secondary, DPS Chennai
INTERESTS                                        Completed in April 2021
Debate                                           CERTIFICATIONS
Photography                                      Google Data Analytics Certificate
Chess                                            Advanced Excel, Coursera
"""

# The false-positive case the detector must NOT flag: an ordinary single-column
# resume that right-aligns its dates. This layout is everywhere and it parses
# fine; calling it broken would be worse than missing a real two-column resume.
RIGHT_ALIGNED_DATES = """VIKRAM NAIR
vikram@example.com | +91 91234 56789 | github.com/vikram

EXPERIENCE
Backend Intern, Meridian Systems                          Jun 2025 - Aug 2025
- Built an ingestion service in Go handling 40000 events per minute
- Cut deploy time from 22 minutes to 4 by parallelising the CI pipeline

Data Analyst Intern, Northwind Retail Analytics            Jan 2025 - Apr 2025
- Automated 11 weekly reports in Python, saving the team 9 hours a week

EDUCATION
B.Tech Information Technology, NIT Trichy                 Aug 2021 - May 2025

SKILLS
Go, Python, SQL, Docker, Kubernetes
"""


# --------------------------------------------------------------------------
# the two properties that matter
# --------------------------------------------------------------------------

def test_score_is_deterministic():
    """Same bytes in, same everything out — ten times over.

    This is the property the whole pivot rests on. The previous scorer was an
    LLM ensemble that returned 70, 76 and 88 for one unchanged document.
    """
    first = readiness.score(STRONG)
    for _ in range(9):
        assert readiness.score(STRONG) == first


def test_score_is_deterministic_with_a_target():
    target = ["python", "docker", "kubernetes"]
    first = readiness.score(STRONG, target)
    for _ in range(5):
        assert readiness.score(STRONG, target) == first


def test_worse_resumes_score_lower():
    order = [SCANNED, PROSE, DUTIES, TWO_COLUMN, STRONG]
    scores = [readiness.score(t)["score"] for t in order]
    assert scores == sorted(scores), scores
    # And the spread is real, not three points across the whole range.
    assert scores[-1] - scores[0] > 50


# --------------------------------------------------------------------------
# readable
# --------------------------------------------------------------------------

def test_an_unreadable_file_cannot_pass_on_its_other_bands():
    """A scanned resume must never show a passing headline number.

    Without the cap, the fields/structure bands score the handful of characters
    that leaked out and the total lands in the 30s — printed directly above a
    finding that says the file is empty to a parser.
    """
    r = readiness.score(SCANNED)
    assert r["score"] <= 15
    assert r["grade"] == "F"
    assert any(f["severity"] == "critical" and f["band"] == "readable"
               for f in r["findings"])


def test_icon_font_debris_is_a_critical_finding():
    # Anchor on a string that appears exactly once — "Hyderabad" is in both the
    # header and the education line, so replacing it injected four artifacts and
    # the count assertion failed for a reason unrelated to the detector.
    text = STRONG.replace("PRIYA SHARMA", "(cid:132) PRIYA SHARMA (cid:133)", 1)
    r = readiness.score(text)
    assert r["facts"]["readable"]["cid_artifacts"] == 2
    assert any("unreadable glyphs" in f["problem"] for f in r["findings"])


# --------------------------------------------------------------------------
# fields
# --------------------------------------------------------------------------

def test_a_missing_email_is_critical():
    r = readiness.score(STRONG.replace("priya.sharma@example.com", ""))
    assert any(f["band"] == "fields" and f["severity"] == "critical"
               and "email" in f["problem"].lower() for f in r["findings"])


def test_multi_label_domains_survive_extraction():
    """`priya@iitb.ac.in` must not be truncated to `priya@iitb.ac`.

    Indian academic addresses (.ac.in, .edu.in, .co.in) are the common case in
    this market, and a truncated address is one no employer can reply to.
    """
    got = readiness.find_emails("contact priya@iitb.ac.in for details")
    assert got == ["priya@iitb.ac.in"]


def test_a_date_range_is_not_read_as_a_phone_number():
    assert readiness.find_phones("Worked there 2020-2024 on the platform") == []
    assert readiness.find_phones("+91 98765 43210") == ["+91 98765 43210"]


def test_a_pincode_is_not_a_phone_number():
    assert readiness.find_phones("Hyderabad 500032, Telangana") == []


# --------------------------------------------------------------------------
# structure
# --------------------------------------------------------------------------

def test_prose_is_not_credited_with_bullets():
    """A wall of text must not score well on structure.

    The bullet fallback used to run for every document with no bullet glyphs, so
    each wrapped sentence of a personal statement counted as a bullet point and
    prose scored 82/100 on the band that exists to measure whether the document
    has any structure at all.
    """
    r = readiness.score(PROSE)
    assert r["facts"]["structure"]["bullets"] == 0
    assert r["bands"]["structure"]["score"] < 65
    assert any("prose" in f["problem"].lower() for f in r["findings"])


def test_a_real_bulleted_resume_is_credited():
    r = readiness.score(STRONG)
    assert r["facts"]["structure"]["bullets"] >= 6
    assert r["bands"]["structure"]["score"] == 100


def test_two_column_layout_is_detected():
    lines = [ln for ln in TWO_COLUMN.splitlines() if ln.strip()]
    assert readiness.detect_two_column(lines)["is_two_column"] is True
    r = readiness.score(TWO_COLUMN)
    assert any("two columns" in f["problem"] for f in r["findings"])


def test_right_aligned_dates_are_not_mistaken_for_two_columns():
    """The false positive that matters, tested ABOVE the evidence floor.

    A single-column resume with right-aligned dates produces exactly one wide
    gap per line, which is what a naive detector keys on. Flagging this layout
    as broken would tell most well-formatted resumes in the market that they
    need rebuilding, which is the fastest way to lose trust in every other
    number on the page.

    The first version of this test used a fixture with only THREE wide-gap
    lines — below `_MIN_COLUMN_LINES = 5` — so it passed on the evidence floor
    and would have passed with the detector completely broken. It was: the
    length threshold was 15 characters, described as "a date is shorter than
    this", and "Jun 2025 - Aug 2025" is 19. This fixture has eight.
    """
    resume = """VIKRAM NAIR
vikram@example.com | +91 91234 56789 | github.com/vikram

EXPERIENCE
Backend Intern, Meridian Systems                          Jun 2025 - Aug 2025
- Built an ingestion service in Go handling 40000 events per minute
Data Analyst Intern, Northwind Retail Analytics            Jan 2025 - Apr 2025
- Automated 11 weekly reports in Python, saving 9 hours a week
Research Assistant, Signal Processing Lab                  Aug 2024 - Dec 2024
- Implemented 6 filter designs in MATLAB for a published paper

EDUCATION
B.Tech Information Technology, NIT Trichy                 Aug 2021 - May 2025
Higher Secondary, Kendriya Vidyalaya Chennai              Jun 2019 - Apr 2021

PROJECTS
LedgerLite - double entry accounting engine                Mar 2024 - Jun 2024
- Designed a Postgres schema handling 250000 transactions
Fleetwise - vehicle telemetry dashboard                    Sep 2023 - Dec 2023
- Streamed 12000 events per second into a time series store

SKILLS
Go, Python, SQL, Docker, MATLAB
"""
    lines = [ln for ln in resume.splitlines() if ln.strip()]
    detected = readiness.detect_two_column(lines)
    assert detected["is_two_column"] is False, detected
    r = readiness.score(resume)
    assert not any("two columns" in f["problem"] for f in r["findings"])
    assert r["bands"]["structure"]["score"] >= 85


def test_an_empty_document_scores_nothing_on_structure():
    """It used to score 15/100 for "not being two-column" — a band score for a
    file with nothing in it, printed beside a critical finding saying so."""
    assert readiness.score("")["bands"]["structure"]["score"] == 0


def test_two_column_needs_enough_evidence():
    """Three aligned lines is a coincidence, not a layout."""
    lines = [
        "Alpha                 Beta gamma delta epsilon",
        "Gamma                 Delta epsilon zeta eta",
    ]
    assert readiness.detect_two_column(lines)["is_two_column"] is False


# --------------------------------------------------------------------------
# impact
# --------------------------------------------------------------------------

def test_duty_bullets_score_far_below_outcome_bullets():
    duties = readiness.score(DUTIES)["bands"]["impact"]["score"]
    outcomes = readiness.score(STRONG)["bands"]["impact"]["score"]
    assert duties < 25
    assert outcomes > 80
    assert outcomes - duties > 50


def test_a_strong_resume_still_leaves_headroom():
    """There must be room above a genuinely good resume.

    A scorer that returns 100 for the first realistic input cannot show a
    rewrite improving anything, which is the one thing this product sells. This
    fixture is a strong resume — 82% of bullets action-led, 73% quantified — and
    it should score well without maxing the band.
    """
    r = readiness.score(STRONG)
    assert r["facts"]["impact"]["action_pct"] >= 80
    assert r["facts"]["impact"]["quantified_pct"] >= 70
    assert 80 <= r["bands"]["impact"]["score"] < 100


def test_a_flawless_resume_can_still_reach_full_marks():
    """The ceiling must be reachable, or the band is dishonest in the other
    direction — a resume where every bullet leads with a verb and states a
    number has nothing left for us to find."""
    flawless = """RAVI IYER
ravi@example.com | +91 90000 11111 | github.com/ravi

EDUCATION
B.Tech Computer Science, IIT Madras | Aug 2021 - May 2025 | CGPA 9.1/10

EXPERIENCE
Backend Intern, Helios Systems | Jun 2024 - Aug 2024
- Built an event pipeline in Go processing 40000 events per minute
- Reduced p99 latency from 1200ms to 180ms by batching writes
- Automated 11 manual reports, saving 9 hours per week

PROJECTS
LedgerLite - double entry accounting engine
- Designed a Postgres schema handling 250000 transactions with 99.99% consistency
- Wrote 120 property tests covering 94% of the reconciliation module

TECHNICAL SKILLS
Languages: Go, Python, SQL
Tools: Docker, Postgres, Kafka, Linux
"""
    assert readiness.score(flawless)["bands"]["impact"]["score"] == 100


def test_quantities_are_recognised_in_the_forms_resumes_use():
    from readiness import _QUANTITY_RE
    for good in ["12000 daily requests", "reduced by 40%", "₹2.5 lakh", "22 FPS",
                 "8000 frames", "190ms", "50k+", "3 months", "1400 students"]:
        assert _QUANTITY_RE.search(good), good
    for bad in ["the API", "using Python", "a team"]:
        assert not _QUANTITY_RE.search(bad), bad


# --------------------------------------------------------------------------
# coverage
# --------------------------------------------------------------------------

def test_coverage_is_only_scored_when_there_is_a_target():
    untargeted = readiness.score(STRONG)
    assert untargeted["targeted"] is False
    assert "coverage" not in untargeted["bands"]
    targeted = readiness.score(STRONG, ["python"])
    assert targeted["targeted"] is True
    assert "coverage" in targeted["bands"]


def test_weights_always_total_one_hundred():
    """Whether or not a target is set. A resume with no JD attached is being
    measured on four dimensions, not failing a fifth."""
    for has_jd in (False, True):
        assert round(sum(readiness._weights(has_jd).values()), 6) == 100.0


def test_redistributing_the_coverage_weight_is_score_neutral():
    """Attaching a job description the resume fully covers must not move the score.

    This is the real invariant behind the redistribution, and a much sharper
    test than any absolute threshold. If `coverage` were simply scored as zero
    when absent (the obvious bug), an untargeted resume would be capped at 85
    and the headline number would depend on whether the user had pasted a job
    description yet — the same document, two different scores, for no reason the
    user could see.
    """
    untargeted = readiness.score(STRONG)["score"]
    fully_covered = readiness.score(STRONG, ["python", "react", "docker", "sql"])["score"]
    assert abs(untargeted - fully_covered) <= 1


def test_an_uncovered_target_lowers_the_score():
    """The other half: coverage has to actually bite, or the band is decoration."""
    untargeted = readiness.score(STRONG)["score"]
    uncovered = readiness.score(STRONG, ["cobol", "fortran", "abap", "labview"])["score"]
    assert untargeted - uncovered >= 12


def test_missing_skills_are_named_not_invented():
    r = readiness.score(STRONG, ["python", "kubernetes", "kafka"])
    cov = r["facts"]["coverage"]
    assert "python" in cov["covered"]
    assert set(cov["missing"]) == {"kubernetes", "kafka"}
    fix = next(f["fix"] for f in r["findings"] if f["band"] == "coverage")
    assert "never add a skill you did not claim" in fix.lower()


def test_skill_matching_uses_token_boundaries():
    """Substring matching silently inflates every coverage score: 'r' matches
    every word containing the letter and 'go' matches 'google'."""
    assert readiness._skill_present("i know google cloud", "go") is False
    assert readiness._skill_present("i write go and rust", "go") is True
    assert readiness._skill_present("experienced in react", "r") is False


def test_alias_matching_runs_in_both_directions():
    assert readiness._skill_present("deployed on k8s", "kubernetes") is True
    assert readiness._skill_present("managed kubernetes clusters", "k8s") is True
    assert readiness._skill_present("built with node.js", "node") is True


# --------------------------------------------------------------------------
# parse fidelity
# --------------------------------------------------------------------------

def test_parse_fidelity_counts_what_survived():
    facts = ["Built a REST API in FastAPI", "Reduced latency to 190ms",
             "Trained a MobileNetV2 classifier"]
    got = readiness.parse_fidelity(facts, STRONG)
    assert got["total"] == 3
    assert got["recovered"] == 3
    assert got["pct"] == 100


def test_parse_fidelity_reports_what_was_lost():
    facts = ["Built a REST API in FastAPI", "Led a team of forty accountants"]
    got = readiness.parse_fidelity(facts, STRONG)
    assert got["recovered"] == 1
    assert got["lost"] == ["Led a team of forty accountants"]
    assert got["pct"] == 50


def test_parse_fidelity_tolerates_line_wrapping():
    """Exact string matching fails on the whitespace a PDF text layer invents,
    which would report a perfectly rendered resume as having lost everything."""
    fact = "Reduced median query latency from 840ms to 190ms using Redis caching"
    wrapped = "Reduced median query latency from 840ms\nto 190ms using Redis\ncaching"
    assert readiness.parse_fidelity([fact], wrapped)["recovered"] == 1


def test_parse_fidelity_of_nothing_is_not_a_failure():
    assert readiness.parse_fidelity([], "anything")["pct"] == 100


def test_parse_fidelity_does_not_count_substring_matches():
    """The headline number must not be inflated by fragments.

    The membership test was `token in text`, so "Go" matched "google" and
    "React" matched "reactor" — the same substring bug `_skill_present` carries
    a docstring warning about, in the one number the product leads with.
    """
    assert readiness.parse_fidelity(["Go React"], "google reactor")["recovered"] == 0
    assert readiness.parse_fidelity(["Go React"], "wrote Go and React")["recovered"] == 1


def test_a_run_of_years_is_not_read_as_a_phone_number():
    """"Batch 2020 2024 2021" has a phone-number digit count and no other tell.
    Awarding the phone credit to a resume with no phone number on it is the kind
    of quiet wrongness that makes the whole score untrustworthy."""
    assert readiness.find_phones("Roll No 20BCE1234 Batch 2020 2024 2021") == []
    assert readiness.find_phones("Reach me on 98765 43210 any time") == ["98765 43210"]


def test_version_numbers_are_not_counted_as_achievement_metrics():
    """"Java 8+" and "React 18+" were inflating the impact band for resumes
    that stated no outcomes at all."""
    from readiness import _QUANTITY_RE
    for version in ["Worked with Java 8+", "Used React 18+ in production", "Python 3+"]:
        assert not _QUANTITY_RE.search(version), version
    for real in ["50k+ tokens", "1000+ users", "reached 200+ downloads"]:
        assert _QUANTITY_RE.search(real), real


def test_whitespace_padding_does_not_buy_score():
    """`chars` counted layout padding as content, so heavy right-alignment
    bought readable-band score a dense resume did not get."""
    dense = readiness.score(STRONG)
    padded = readiness.score(STRONG.replace(" | ", "        |        "))
    assert padded["bands"]["readable"]["score"] == dense["bands"]["readable"]["score"]
    assert abs(padded["facts"]["readable"]["chars"] - dense["facts"]["readable"]["chars"]) <= 2


# --------------------------------------------------------------------------
# grading
# --------------------------------------------------------------------------

def test_grade_matches_the_score_it_was_derived_from():
    for value, letter in ((100, "A"), (85, "A"), (84, "B"), (70, "B"),
                          (69, "C"), (55, "C"), (54, "D"), (40, "D"), (39, "F"), (0, "F")):
        assert readiness.grade(value) == letter
    for text in (STRONG, PROSE, DUTIES, SCANNED):
        r = readiness.score(text)
        assert r["grade"] == readiness.grade(r["score"])


def test_score_is_always_in_range():
    for text in ("", " ", SCANNED, PROSE, DUTIES, TWO_COLUMN, STRONG, "x" * 50000):
        r = readiness.score(text)
        assert 0 <= r["score"] <= 100
        for band in r["bands"].values():
            assert 0 <= band["score"] <= 100


def test_empty_input_does_not_raise():
    for value in (None, "", "   ", "\n\n"):
        r = readiness.score(value)  # type: ignore[arg-type]
        assert r["score"] == 0 or r["score"] <= 15
        assert r["findings"]


# ---------------------------------------------------------------------------
# career stage — read off the resume, used for the one-page suggestion
# ---------------------------------------------------------------------------

def test_career_stage_reads_a_student_from_the_degree_line():
    text = (
        "Priya Sharma\nB.Tech in Computer Science, Anurag University, 2023 - 2027 (expected)\n"
        "EXPERIENCE\nSoftware Engineering Intern, Zenlytics, Jun 2025 - Aug 2025\n- Built a REST API\n"
    )
    got = readiness.career_stage(text, 2026)
    assert got["stage"] == "student"
    assert any("2027" in s for s in got["signals"])


def test_career_stage_reads_a_fresher_from_a_recent_degree_and_internships():
    text = (
        "Arjun Mehta\nB.E. Computer Engineering, Pune University, 2021 - 2025\n"
        "Internship: Data Analyst Intern, Acme, Jan 2025 - Apr 2025\nSKILLS python sql\n"
    )
    assert readiness.career_stage(text, 2026)["stage"] == "fresher"


def test_career_stage_reads_early_career_from_dated_roles():
    text = (
        "Neha Rao\nSoftware Engineer, Flipkart, 2022 - Present\n"
        "Backend Engineer, Zomato, 2020 - 2022\nB.Tech, VIT, 2016 - 2020\n"
    )
    got = readiness.career_stage(text, 2026)
    assert got["stage"] == "early"
    assert got["years"] == 6


def test_career_stage_does_not_call_a_long_career_a_student():
    text = (
        "Vikram Singh\nSenior Engineering Manager, Infosys, 2015 - Present\n"
        "Lead Engineer, TCS, 2010 - 2015\nSoftware Engineer, Wipro, 2007 - 2010\nB.Tech, NIT, 2003 - 2007\n"
    )
    assert readiness.career_stage(text, 2026)["stage"] == "experienced"


def test_career_stage_is_pure_in_the_clock():
    text = "B.Tech, 2022 - 2026 (expected)\nIntern, Acme, 2025 - 2025\n"
    assert readiness.career_stage(text, 2025)["stage"] == "student"
    # Three years later the same text reads as a fresher-turned-early, not a student.
    assert readiness.career_stage(text, 2029)["stage"] != "student"


def test_career_stage_is_not_fooled_by_title_words_in_project_names():
    """Seen on a real two-page student resume: "Library Manager" (a project)
    matched the senior-title words and tipped the read to "experienced"."""
    text = (
        "Priya Sharma\nB.Tech in Computer Science, Anurag University | Aug 2023 - May 2027 (expected)\n"
        "Software Engineering Intern, Zenlytics | Jun 2025 - Aug 2025\n"
        "Project: Library Manager | 2024 - 2025\n- Built an admin panel\n"
        "Project: Team Lead tracker | 2024 - 2025\n"
    )
    assert readiness.career_stage(text, 2026)["stage"] == "student"
