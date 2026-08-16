"""The gates, measured in BOTH directions.

An anti-fabrication gate has two failure modes and they pull against each
other. A gate that lets an invented technology through puts a lie on a document
someone sends to an employer. A gate that rejects an honest rewrite produces
nothing and blames the user's resume for it — and that one is not the lesser
evil, because it is the failure the user actually experiences.

An adversarial review measured 9 of 26 fabrications surviving AND 56% of honest
rewrites being rejected, at the same time. Both numbers are pinned here.
"""
from __future__ import annotations

import pytest

import resume_optimize as RO

MASTER = """PRIYA SHARMA
Hyderabad, India | +91 98765 43210 | priya.sharma@example.com | github.com/priyasharma

EDUCATION
B.Tech in Computer Science and Engineering
Anurag University, Bengaluru | Aug 2022 - May 2026 | CGPA: 8.4/10

EXPERIENCE
Software Engineering Intern, Zenlytics Pvt Ltd
Jun 2025 - Aug 2025
- Built REST APIs in FastAPI and PostgreSQL serving 12000 daily requests
- Reduced median query latency from 4s to 1.2s by adding Redis caching
- Wrote 46 pytest cases covering the billing module, raising coverage to 78%

Web Development Intern, Anurag Innovation Cell
Jan 2025 - Apr 2025
- Developed the placement portal front end in React, used by 1400 students

PROJECTS
DriveSense - driver drowsiness detection
- Trained a CNN in PyTorch on 8000 labelled frames, reaching 94% accuracy

TECHNICAL SKILLS
Languages: Python, JavaScript, SQL
Tools: Docker, Git, PostgreSQL, Redis, Linux
"""

SKILLS = ["python", "javascript", "sql", "docker", "git", "postgresql",
          "redis", "linux", "fastapi", "pytorch", "react"]


@pytest.fixture(scope="module")
def ctx():
    return {
        "stems": RO._source_stems(MASTER),
        "allowed": RO._allowed_tokens(MASTER, SKILLS),
    }


def _run(struct: dict, ctx) -> tuple[dict, list[str], list[str]]:
    """Push a rewrite through both gates. Returns (kept, dropped, invented)."""
    base = RO._extract_struct.__wrapped__ if hasattr(RO._extract_struct, "__wrapped__") else None
    # A minimal ancestor index built from the master's own items, so provenance
    # has something real to match against.
    base_struct = {
        "name": "Priya Sharma", "contact_line": "",
        "sections": [
            {"heading": "Education", "items": [
                {"head": "B.Tech in Computer Science and Engineering",
                 "sub": "Anurag University, Bengaluru | Aug 2022 - May 2026 | CGPA: 8.4/10",
                 "bullets": []},
            ]},
            {"heading": "Experience", "items": [
                {"head": "Software Engineering Intern, Zenlytics Pvt Ltd",
                 "sub": "Jun 2025 - Aug 2025",
                 "bullets": [
                     "Built REST APIs in FastAPI and PostgreSQL serving 12000 daily requests",
                     "Reduced median query latency from 4s to 1.2s by adding Redis caching",
                     "Wrote 46 pytest cases covering the billing module, raising coverage to 78%",
                 ]},
                {"head": "Web Development Intern, Anurag Innovation Cell",
                 "sub": "Jan 2025 - Apr 2025",
                 "bullets": ["Developed the placement portal front end in React, used by 1400 students"]},
            ]},
            {"heading": "Projects", "items": [
                {"head": "DriveSense - driver drowsiness detection", "sub": "",
                 "bullets": ["Trained a CNN in PyTorch on 8000 labelled frames, reaching 94% accuracy"]},
            ]},
            {"heading": "Technical Skills", "items": [
                {"head": "Languages", "sub": "", "bullets": ["Python", "JavaScript", "SQL"]},
                {"head": "Tools", "sub": "", "bullets": ["Docker", "Git", "PostgreSQL", "Redis", "Linux"]},
            ]},
        ],
    }
    kept, dropped = RO._ground_struct(struct, ctx["stems"], base_struct)
    invented = RO._fabricated_skills(struct, ctx["allowed"])
    return kept, dropped, invented


def _flat(struct: dict) -> str:
    return RO._flatten(struct).lower()


def _wrap(section: str, item: dict) -> dict:
    return {"name": "Priya Sharma", "contact_line": "",
            "sections": [{"heading": section, "items": [item]}]}


# --------------------------------------------------------------------------
# fabrications that must NOT reach the document
# --------------------------------------------------------------------------

FABRICATIONS = [
    (
        "lowercase tech in prose",
        _wrap("Experience", {
            "head": "Software Engineering Intern, Zenlytics Pvt Ltd",
            "sub": "Jun 2025 - Aug 2025",
            "bullets": ["Tuned pinecone and weaviate retrieval for the search stack"],
        }),
        ["pinecone", "weaviate"],
    ),
    (
        "tech hidden in a skills-group head",
        _wrap("Technical Skills", {
            "head": "Vector DBs: Pinecone, Weaviate, Milvus", "sub": "", "bullets": [],
        }),
        ["pinecone", "weaviate", "milvus"],
    ),
    (
        "short acronyms in a skills list",
        _wrap("Technical Skills", {
            "head": "Cloud", "sub": "", "bullets": ["ECS", "IAM", "SQS"],
        }),
        ["ecs", "iam", "sqs"],
    ),
    (
        "capitalised product name in prose",
        _wrap("Experience", {
            "head": "Software Engineering Intern, Zenlytics Pvt Ltd",
            "sub": "Jun 2025 - Aug 2025",
            "bullets": ["Owned the Kafka streaming pipeline and Terraform infrastructure"],
        }),
        ["kafka", "terraform"],
    ),
    (
        "invented employer",
        _wrap("Experience", {
            "head": "Senior Engineer, Globex Corporation",
            "sub": "Jan 2019 - Dec 2021",
            "bullets": ["Directed a distributed platform team across three continents"],
        }),
        ["globex"],
    ),
]


@pytest.mark.parametrize("name,struct,forbidden", FABRICATIONS,
                         ids=[f[0] for f in FABRICATIONS])
def test_fabrications_do_not_survive(name, struct, forbidden, ctx):
    kept, dropped, invented = _run(struct, ctx)
    surviving = _flat(kept)
    leaked = [w for w in forbidden if w in surviving]
    assert not leaked, f"{name}: {leaked} reached the document"


# --------------------------------------------------------------------------
# honest rewrites that must survive
# --------------------------------------------------------------------------

HONEST = [
    ("expanded degree name",
     "Bachelor of Technology in Computer Science and Engineering"),
    ("expanded acronym", "Built RESTful APIs in FastAPI and PostgreSQL"),
    ("singular of a plural in the source", "Built a REST API in FastAPI"),
    ("expanded CNN", "Trained a Convolutional Neural Network in PyTorch on 8000 frames"),
    ("spelled-out month", "August 2022 - May 2026"),
    ("city alias", "Anurag University, Bangalore"),
    ("reworded with synonyms",
     "Engineered REST APIs in FastAPI and PostgreSQL, serving 12000 requests each day"),
    ("merged two real bullets",
     "Built REST APIs in FastAPI and PostgreSQL and cut median query latency from 4s to 1.2s"),
    ("British spelling", "Optimised the billing module, raising coverage to 78%"),
    ("action verb capitalised mid-sentence",
     "Rewrote the pipeline and Reduced latency to 1.2s"),
]


@pytest.mark.parametrize("name,bullet", HONEST, ids=[h[0] for h in HONEST])
def test_honest_rewrites_are_not_rejected(name, bullet, ctx):
    """A truthful rewording must never be reported as an invented claim.

    This is the half that was 56% broken. The user-visible symptom was not a
    warning — it was the whole variant being discarded, with the audit trail
    blaming their resume.
    """
    bad = RO.ungrounded_in_bullet(bullet, ctx["stems"])
    assert bad == [], f"{name}: falsely flagged {bad}"


def test_a_derived_percentage_is_allowed():
    """"70% (4s to 1.2s)" is arithmetic over two numbers the source states, and
    it is exactly what the Impact-focused strategy asks the model to produce.
    Rejecting it made that strategy self-defeating."""
    stems = RO._source_stems(MASTER)
    bad = RO.ungrounded_in_bullet("Cut query latency 70% (4s to 1.2s) with Redis caching", stems)
    assert "70" not in bad


def test_a_singular_skill_does_not_reject_the_whole_variant(ctx):
    """Source says "APIs"; a rewrite writing "API" used to be reported as an
    invented skill and cost the user every variant."""
    struct = _wrap("Experience", {
        "head": "Software Engineering Intern, Zenlytics Pvt Ltd",
        "sub": "Jun 2025 - Aug 2025",
        "bullets": ["Built a REST API in FastAPI and PostgreSQL serving 12000 daily requests"],
    })
    _, _, invented = _run(struct, ctx)
    assert invented == [], invented


def test_a_full_honest_rewrite_survives_intact(ctx):
    """The end-to-end case: every real item reworded, nothing invented.

    A realistic truthful rewrite kept 1 of 5 factual items and tripped the drift
    check, so the product produced nothing for an honest user.
    """
    rewrite = {
        "name": "Priya Sharma", "contact_line": "",
        "sections": [
            {"heading": "Education", "items": [
                {"head": "Bachelor of Technology in Computer Science and Engineering",
                 "sub": "Anurag University, Bengaluru | Aug 2022 - May 2026 | CGPA: 8.4/10",
                 "bullets": []},
            ]},
            {"heading": "Experience", "items": [
                {"head": "Software Engineering Intern, Zenlytics Pvt Ltd",
                 "sub": "Jun 2025 - Aug 2025",
                 "bullets": [
                     "Engineered RESTful APIs in FastAPI and PostgreSQL serving 12000 daily requests",
                     "Cut median query latency from 4s to 1.2s by introducing Redis caching",
                     "Authored 46 pytest cases for the billing module, lifting coverage to 78%",
                 ]},
                {"head": "Web Development Intern, Anurag Innovation Cell",
                 "sub": "Jan 2025 - Apr 2025",
                 "bullets": ["Developed the placement portal front end in React for 1400 students"]},
            ]},
            {"heading": "Projects", "items": [
                {"head": "DriveSense - driver drowsiness detection", "sub": "",
                 "bullets": ["Trained a CNN in PyTorch on 8000 labelled frames to 94% accuracy"]},
            ]},
            {"heading": "Technical Skills", "items": [
                {"head": "Languages", "sub": "", "bullets": ["Python", "JavaScript", "SQL"]},
                {"head": "Tools", "sub": "", "bullets": ["Docker", "Git", "PostgreSQL", "Redis"]},
            ]},
        ],
    }
    kept, dropped, invented = _run(rewrite, ctx)
    assert invented == [], f"falsely flagged skills: {invented}"
    assert dropped == [], f"falsely dropped: {dropped}"
    # Every factual item survives, so the drift check downstream cannot fire.
    assert RO._factual_item_count(kept) == RO._factual_item_count(rewrite)
