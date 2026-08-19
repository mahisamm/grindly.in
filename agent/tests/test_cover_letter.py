"""The cover-letter gate.

Same approach as test_gates.py: the only way to prove a gate works is to hand it
a letter that lies, because a real model mostly behaves. Both directions are
measured — the fabrications that must be caught, and the honest letters that
must survive, because a gate that rejects everything is not a safe gate, it is a
broken feature.
"""
from __future__ import annotations

import cover_letter

RESUME = """
Priya Sharma
priya@example.com | +91 98765 43210 | Bengaluru

EXPERIENCE
Backend Engineer, Freshworks, Jan 2024 - Present
- Cut a Postgres import path from 40 minutes to 6.
- Led the migration of 14 services onto a shared auth library.
- Wrote the load tests that caught a connection-pool leak before release.

Software Intern, Zoho, May 2023 - Jul 2023
- Built an internal dashboard in Python and Flask.

EDUCATION
B.E. Computer Science, MIET, 2020 - 2024. CGPA 8.7

TECHNICAL SKILLS
Languages: Python, SQL, Java
Tools: Postgres, Docker, Git
"""


# ---------------------------------------------------------------------------
# fabrications that must be caught
# ---------------------------------------------------------------------------

def test_an_invented_technology_is_caught():
    letter = (
        "I build backend services. At Freshworks I moved fourteen services onto a "
        "shared auth library, and I have run the same kind of migration on "
        "Kubernetes clusters at scale."
    )
    problems = cover_letter.check(letter, RESUME)
    assert any("kubernetes" in p.lower() for p in problems)


def test_an_invented_metric_is_caught():
    """The most damaging kind, because it is the most checkable."""
    letter = (
        "I cut a Postgres import path from 40 minutes to 6, and reduced API latency "
        "by 73% across the platform."
    )
    problems = cover_letter.check(letter, RESUME)
    assert any("73" in p for p in problems)


def test_a_real_metric_is_not_caught():
    letter = "I cut a Postgres import path from 40 minutes to 6 and moved 14 services."
    assert cover_letter.check(letter, RESUME) == []


def test_an_invented_employer_is_caught():
    letter = "I have worked at Freshworks and before that at Infosys on payments systems."
    problems = cover_letter.check(letter, RESUME)
    assert any("Infosys" in p for p in problems)


def test_the_target_company_is_allowed_to_be_named():
    """The company being applied to is the one proper noun the letter legitimately
    knows that the resume does not."""
    letter = "I would like to work at Razorpay. At Freshworks I moved 14 services."
    assert cover_letter.check(letter, RESUME, company="Razorpay") == []


def test_an_invented_tenure_is_caught():
    """The lie this format invites, and the first thing a recruiter checks."""
    letter = "I have five years of experience building backend services in Python."
    problems = cover_letter.check(letter, RESUME)
    assert any("length of experience" in p for p in problems)


def test_a_tenure_written_in_digits_is_caught_too():
    letter = "With 6+ years shipping Python services, I would be a strong fit."
    problems = cover_letter.check(letter, RESUME)
    assert any("length of experience" in p for p in problems)


def test_a_stated_tenure_is_allowed():
    source = RESUME + "\nSUMMARY\nBackend engineer with 2 years of experience.\n"
    letter = "I have 2 years of experience building backend services in Python."
    assert cover_letter.check(letter, source) == []


# ---------------------------------------------------------------------------
# honest letters that must survive
# ---------------------------------------------------------------------------

def test_an_honest_letter_passes_untouched():
    letter = (
        "At Freshworks I cut a Postgres import path from 40 minutes to 6, and led the "
        "migration of 14 services onto a shared auth library. Before that I built an "
        "internal dashboard in Python and Flask during an internship at Zoho. "
        "I work mainly in Python and SQL, with Postgres and Docker."
    )
    assert cover_letter.check(letter, RESUME) == []


def test_ordinary_rewording_is_not_treated_as_invention():
    """A gate that only passes letters quoting the resume verbatim is a gate that
    has made the feature useless."""
    letter = (
        "Most of my work has been on data paths that were too slow: I took one import "
        "from forty minutes down to six. I have also done the unglamorous half, moving "
        "fourteen services onto shared authentication without downtime."
    )
    assert cover_letter.check(letter, RESUME) == []


def test_years_in_a_date_range_are_not_read_as_a_tenure_claim():
    letter = "I studied at MIET from 2020 to 2024 and joined Freshworks in Jan 2024."
    assert cover_letter.check(letter, RESUME) == []


def test_the_candidates_own_name_is_allowed():
    letter = "Priya Sharma. I work in Python at Freshworks."
    assert cover_letter.check(letter, RESUME) == []


def test_one_repeated_fabrication_is_reported_once():
    letter = "I use Kubernetes daily. Kubernetes is where I am strongest. Kubernetes."
    problems = cover_letter.check(letter, RESUME)
    assert len([p for p in problems if "kubernetes" in p.lower()]) == 1


# ---------------------------------------------------------------------------
# the writer, with the model stubbed
# ---------------------------------------------------------------------------

def test_a_short_resume_is_refused_without_calling_a_model(monkeypatch):
    called = []
    monkeypatch.setattr(cover_letter.llm_mod, "chat_ensemble", lambda *a, **k: called.append(1) or [])
    result = cover_letter.write("too short")
    assert result["ok"] is False
    assert not called


def test_a_lying_draft_is_discarded_rather_than_repaired(monkeypatch):
    """A repaired letter is a different letter that nobody has read."""
    monkeypatch.setattr(
        cover_letter.llm_mod,
        "chat_ensemble",
        lambda *a, **k: [
            '{"letter": "I have deep Kubernetes and Terraform experience across many '
            'years of production work at Infosys, where I raised throughput by 84%. '
            'This is padding to clear the minimum length for a draft so that the gate '
            'is what rejects it rather than the length check.", "used": []}'
        ],
    )
    result = cover_letter.write(RESUME, company="Razorpay")
    assert result["ok"] is False
    assert result["problems"]


def test_an_honest_draft_is_returned(monkeypatch):
    body = (
        "At Freshworks I cut a Postgres import path from 40 minutes to 6, and led the "
        "migration of 14 services onto a shared auth library. Before that I built an "
        "internal dashboard in Python and Flask at Zoho. I work mainly in Python, SQL "
        "and Postgres, and I am comfortable with Docker."
    )
    monkeypatch.setattr(
        cover_letter.llm_mod,
        "chat_ensemble",
        lambda *a, **k: ['{"letter": %s, "used": ["14 services", "40 minutes to 6"]}' % _json(body)],
    )
    result = cover_letter.write(RESUME, company="Razorpay")
    assert result["ok"] is True
    assert "Freshworks" in result["letter"]
    assert result["used"]


def test_the_first_clean_draft_wins(monkeypatch):
    """Drafts are checked one at a time, not merged. Merging prose by consensus
    produces a sentence no model wrote — the same bug the struct extractor hit."""
    bad = (
        "I have extensive Kubernetes experience and raised throughput by 84% at "
        "Infosys, which is padding to clear the minimum length for this draft."
    )
    good = (
        "At Freshworks I cut a Postgres import path from 40 minutes to 6 and moved 14 "
        "services onto a shared auth library. I work in Python, SQL and Postgres, and "
        "I have used Docker and Git throughout. Before that I built an internal "
        "dashboard in Python and Flask during an internship at Zoho."
    )
    monkeypatch.setattr(
        cover_letter.llm_mod,
        "chat_ensemble",
        lambda *a, **k: [
            '{"letter": %s, "used": []}' % _json(bad),
            '{"letter": %s, "used": []}' % _json(good),
        ],
    )
    result = cover_letter.write(RESUME)
    assert result["ok"] is True
    assert "Kubernetes" not in result["letter"]


def _json(value: str) -> str:
    import json

    return json.dumps(value)


# ---------------------------------------------------------------------------
# the false positives that broke the feature on the live site
# ---------------------------------------------------------------------------

def test_ordinary_english_that_happens_to_be_in_the_vocabulary():
    """The bug this section exists for.

    On production, a perfectly honest first draft was rejected with "names a
    technology that is not on the resume: systems" and "...: processing". Both
    are real entries in a vocabulary that also holds system, data, testing,
    design, cloud, api, analytics, vision, learning and automation. The feature
    refused nearly every letter — and a gate that rejects everything is not a
    safe gate, it is a removed feature.
    """
    letter = (
        "I have built systems for data processing at Freshworks, with a focus on "
        "testing and automation. The design work there covered a cloud migration "
        "of 14 services onto shared authentication, and I did the load testing "
        "that caught a connection-pool leak."
    )
    assert cover_letter.check(letter, RESUME) == []


def test_a_capitalised_word_inside_a_job_title_is_not_a_claim():
    letter = (
        "I am applying for the Data Engineer role. At Freshworks I cut a Postgres "
        "import path from 40 minutes to 6, and moved 14 services onto a shared "
        "auth library without downtime."
    )
    assert cover_letter.check(letter, RESUME) == []


def test_a_sentence_opening_with_an_ordinary_word_is_not_a_claim():
    letter = (
        "Systems work is most of what I do. Processing pipelines were my focus at "
        "Freshworks, where I took one import from 40 minutes to 6 and moved 14 "
        "services onto a shared auth library."
    )
    assert cover_letter.check(letter, RESUME) == []


def test_an_invented_tool_written_as_a_name_is_still_caught():
    """The casing rule must not have opened the door it was narrowing."""
    for letter, expected in [
        ("At Freshworks I moved 14 services. I have also run Kubernetes at scale.", "kubernetes"),
        ("I have deep AWS experience beyond my work at Freshworks.", "aws"),
        ("I built the pipeline in Terraform while at Freshworks.", "terraform"),
    ]:
        problems = cover_letter.check(letter, RESUME)
        assert any(expected in p.lower() for p in problems), f"{expected} slipped through"


def test_a_technology_that_is_on_the_resume_is_never_flagged():
    letter = (
        "I work in Python and SQL, with Postgres and Docker, and I use Git daily. "
        "At Freshworks that meant moving 14 services onto a shared auth library."
    )
    assert cover_letter.check(letter, RESUME) == []
