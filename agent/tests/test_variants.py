"""The rewrite pipeline, end to end, with the model stubbed out.

This is the test that matters most in the whole suite, because it is the only
one that exercises the actual product claim: a rewrite is rendered to a real
PDF, read back with the extractor a parser uses, scored on the same ruler as the
master, and dropped if it does not win.

The model is stubbed rather than called. Two reasons, and the second is the one
that would otherwise bite:

  * A test whose result depends on what a provider says today is not a test.
  * The three anti-fabrication gates are the product's central guarantee, and
    the only way to prove they hold is to hand them a rewrite that DOES try to
    fabricate. A real model mostly behaves, so a live run would pass these tests
    while the gates were broken.

These tests render real PDFs with headless Chromium, so they are slower than the
rest of the suite and are marked `slow`. Run just them with `-m slow`, or skip
them with `-m "not slow"` when iterating on the scorer.
"""
from __future__ import annotations

import json
import os

import pytest

import readiness
import render_pdf
import resume_optimize

pytestmark = pytest.mark.slow


MASTER = """PRIYA SHARMA
Hyderabad, India | +91 98765 43210 | priya.sharma@example.com | github.com/priyasharma

EDUCATION
B.Tech in Computer Science and Engineering
Anurag University, Hyderabad | Aug 2022 - May 2026 | CGPA: 8.4/10

EXPERIENCE
Software Engineering Intern, Zenlytics Pvt Ltd
Jun 2025 - Aug 2025
- Built a REST API in FastAPI and PostgreSQL that served 12000 daily requests
- Reduced median query latency from 840ms to 190ms by adding Redis caching
- Wrote 46 pytest cases covering the billing module, raising coverage to 78%

PROJECTS
DriveSense - Driver drowsiness detection
- Trained a MobileNetV2 classifier in PyTorch on 8000 labelled frames to 94% accuracy
- Deployed the model to a Raspberry Pi 4 with OpenCV, achieving 22 FPS on device

TECHNICAL SKILLS
Languages: Python, JavaScript, SQL, C
Tools: Docker, Git, PostgreSQL, Redis, Linux
"""

MASTER_SKILLS = ["python", "javascript", "sql", "c", "docker", "git",
                 "postgresql", "redis", "linux", "fastapi", "pytorch", "opencv"]

# What a well-behaved model returns: the same facts, reworded.
HONEST_STRUCT = {
    "name": "Priya Sharma",
    "contact_line": "Hyderabad, India | +91 98765 43210 | priya.sharma@example.com | github.com/priyasharma",
    "sections": [
        {"heading": "Education", "items": [
            {"head": "B.Tech in Computer Science and Engineering",
             "sub": "Anurag University, Hyderabad | Aug 2022 - May 2026 | CGPA: 8.4/10",
             "bullets": []},
        ]},
        {"heading": "Experience", "items": [
            {"head": "Software Engineering Intern, Zenlytics Pvt Ltd",
             "sub": "Jun 2025 - Aug 2025",
             "bullets": [
                 "Built a REST API in FastAPI and PostgreSQL serving 12000 daily requests",
                 "Reduced median query latency from 840ms to 190ms using Redis caching",
                 "Wrote 46 pytest cases covering the billing module, raising coverage to 78%",
             ]},
        ]},
        {"heading": "Projects", "items": [
            {"head": "DriveSense - Driver drowsiness detection", "sub": "",
             "bullets": [
                 "Trained a MobileNetV2 classifier in PyTorch on 8000 labelled frames to 94% accuracy",
                 "Deployed to a Raspberry Pi 4 with OpenCV, achieving 22 FPS on device",
             ]},
        ]},
        {"heading": "Technical Skills", "items": [
            {"head": "Languages", "sub": "", "bullets": ["Python", "JavaScript", "SQL", "C"]},
            {"head": "Tools", "sub": "", "bullets": ["Docker", "Git", "PostgreSQL", "Redis", "Linux"]},
        ]},
    ],
}


def _stub_llm(monkeypatch, struct, changes=None):
    """Make every ensemble call return one struct. Deterministic by construction.

    Patches `chat_ensemble`, which is what the pipeline actually calls — it wants
    raw strings so it can merge them itself. Patching `chat_json_ensemble`
    instead (the obvious guess, and the first thing tried here) silently changes
    nothing: the real function runs, finds no providers, returns nothing, and
    every test fails with "extraction_failed" for a reason that has nothing to
    do with what it was testing.
    """
    extract_reply = json.dumps(struct)
    rewrite_reply = json.dumps({
        "resume": struct,
        "changes": changes or ["Reworded bullets to lead with the action"],
    })

    def fake(prompt, system="", n=3, timeout=60, temperature=0.3):
        # _extract_struct asks for the resume itself; _rewrite_struct asks for a
        # rewrite wrapped with a change list. They are told apart by their system
        # prompt, which is how the real callers differ too.
        if system == resume_optimize._REWRITE_SYS:
            return [rewrite_reply] * n
        return [extract_reply] * n

    monkeypatch.setattr(resume_optimize.llm_mod, "chat_ensemble", fake)


# --------------------------------------------------------------------------
# the renderer
# --------------------------------------------------------------------------

def test_renderer_is_available():
    """If this fails, nothing else in this file can mean anything."""
    assert render_pdf.renderer_available(), (
        "Playwright/Chromium is missing. Run: python -m playwright install chromium"
    )


def test_render_produces_a_pdf_with_a_readable_text_layer(tmp_path):
    out = str(tmp_path / "r.pdf")
    result = render_pdf.render_fitted(HONEST_STRUCT, out)
    assert result.ok, result.reason
    assert os.path.getsize(out) > 1000
    assert result.pages == 1

    text = render_pdf.extract_back(out)
    # The whole product rests on this: what we printed comes back out.
    assert "Priya Sharma" in text
    assert "FastAPI" in text
    assert "190ms" in text
    assert "MobileNetV2" in text


def test_rendered_pdf_scores_well_on_its_own_scorer(tmp_path):
    """A resume we built must pass the checks we apply to everyone else's.

    If our own clean template scored badly, the product would be telling users
    to rebuild onto something worse than what they had.
    """
    out = str(tmp_path / "r.pdf")
    assert render_pdf.render_fitted(HONEST_STRUCT, out).ok
    report = readiness.score(render_pdf.extract_back(out))
    assert report["score"] >= 70, report["bands"]
    assert report["facts"]["structure"]["two_column"]["is_two_column"] is False


def test_html_escaping_is_total(tmp_path):
    """A resume is untrusted text. It must not be able to inject markup."""
    nasty = {
        "name": '<script>alert(1)</script>',
        "contact_line": 'a" onload="alert(2)',
        "sections": [
            {"heading": "Experience", "items": [
                {"head": "<img src=x onerror=alert(3)>", "sub": "& < > \" '",
                 "bullets": ["</style><b>bold</b>"]},
            ]},
        ],
    }
    html = render_pdf.build_html(nasty)
    # The test is that no ACTIVE markup survives — the characters may of course
    # still be present, escaped. Asserting the substring "onerror=alert" is
    # absent was the wrong check: it appears harmlessly inside
    # "&lt;img src=x onerror=alert(3)&gt;", which is exactly the correct output.
    assert "<script>" not in html
    assert "<img" not in html
    assert "&lt;script&gt;" in html
    assert "&lt;img src=x onerror=alert(3)&gt;" in html
    # The attribute-breakout attempt must not close the attribute it sits in.
    assert 'a" onload=' not in html
    # And it still renders rather than blowing up.
    out = str(tmp_path / "nasty.pdf")
    assert render_pdf.render(nasty, out).ok


@pytest.mark.parametrize("contact", [
    "Hyderabad | priya@example.com",
    "Hyderabad, India | +91 98765 43210 | priya.sharma@example.com",
    "Hyderabad, India | +91 98765 43210 | priya.sharma@example.com | github.com/priyasharma",
    "Hyderabad, Telangana, India | +91 98765 43210 | priya.sharma@iitb.ac.in | "
    "github.com/priyasharma | linkedin.com/in/priyasharma | priyasharma.dev",
])
def test_the_name_always_extracts_before_the_contact_line(contact, tmp_path):
    """A parser reads the first line as the candidate's name.

    With a centred header, a contact line past ~62 characters extracted BEFORE
    the name, so the rebuilt resume introduced its owner as their own address.
    Parameterised over four lengths because the bug only appeared once the
    contact line was long enough to widen its box past the name's.
    """
    struct = {
        "name": "Priya Sharma",
        "contact_line": contact,
        "sections": [{"heading": "Experience", "items": [
            {"head": "Intern, Acme", "sub": "Jun 2025 - Aug 2025",
             "bullets": ["Built a thing that served 1000 users"]}]}],
    }
    out = str(tmp_path / "hdr.pdf")
    assert render_pdf.render(struct, out).ok
    text = render_pdf.extract_back(out)

    name_at = text.find("Priya Sharma")
    contact_at = text.find("Hyderabad")
    assert name_at >= 0 and contact_at >= 0
    assert name_at < contact_at, f"contact extracted before the name:\n{text[:200]!r}"
    assert text.strip().splitlines()[0].strip() == "Priya Sharma"


def test_hyphens_survive_the_round_trip(tmp_path):
    """`_PUA_RE` was once corrupted into `[-]` and silently deleted every hyphen.

    Every date range then printed as "Aug 2022 May 2026", no date was readable
    in the output, and the loss was misdiagnosed as a Chromium font limitation.
    This asserts the character actually makes it through.
    """
    struct = {
        "name": "Test",
        "contact_line": "test@example.com",
        "sections": [{"heading": "Experience", "items": [
            {"head": "Engineer, Acme", "sub": "Aug 2022 - May 2026",
             "bullets": ["Built a peer-to-peer, role-based system"]}]}],
    }
    out = str(tmp_path / "dash.pdf")
    assert render_pdf.render(struct, out).ok
    text = render_pdf.extract_back(out)
    assert "Aug 2022 - May 2026" in text
    assert "peer-to-peer" in text
    # And the date range is readable by the scorer, which is the point.
    assert readiness.find_date_ranges(text)


def test_bullet_glyphs_reach_the_text_layer(tmp_path):
    """A CSS list marker paints on the page and is absent from the text.

    Our own rebuilds therefore scored as prose on the structure band — the
    renderer was producing documents its own scorer marked down.
    """
    out = str(tmp_path / "bullets.pdf")
    assert render_pdf.render(HONEST_STRUCT, out).ok
    text = render_pdf.extract_back(out)
    assert render_pdf.BULLET_GLYPH in text
    report = readiness.score(text)
    assert report["facts"]["structure"]["bullets"] >= 4


def test_icon_font_debris_is_stripped_before_printing(tmp_path):
    """We penalise other resumes for `(cid:132)`; we must not print it ourselves."""
    struct = json.loads(json.dumps(HONEST_STRUCT))
    struct["contact_line"] = "(cid:132) +91 98765 43210 (cid:141) priya.sharma@example.com"
    html = render_pdf.build_html(struct)
    assert "cid:" not in html
    assert "+91 98765 43210" in html


# --------------------------------------------------------------------------
# the pipeline
# --------------------------------------------------------------------------

def test_generate_variants_produces_measured_rewrites(monkeypatch, tmp_path):
    _stub_llm(monkeypatch, HONEST_STRUCT)
    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)

    assert result["aborted"] is None, result
    assert result["variants"], result["reasons"]

    for v in result["variants"]:
        assert v["pdf_bytes"][:4] == b"%PDF"
        assert isinstance(v["score"], int)
        # The contract: nothing below the master is ever returned.
        assert v["score"] >= v["baseline_score"]
        # Every variant carries its own full report and fidelity count.
        assert v["report"]["score"] == v["score"]
        assert v["fidelity"]["total"] > 0


def test_the_headline_claim_is_actually_measured(monkeypatch):
    """Fidelity must be computed from the rendered PDF, not asserted.

    A high number here is only meaningful if it fell out of reading the file
    back. This asserts the recovered count is consistent with a real round trip.
    """
    _stub_llm(monkeypatch, HONEST_STRUCT)
    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)
    assert result["variants"]
    fidelity = result["variants"][0]["fidelity"]
    assert fidelity["recovered"] <= fidelity["total"]
    assert fidelity["pct"] >= 90, fidelity["lost"]


def test_identity_is_never_taken_from_the_model(monkeypatch, tmp_path):
    """The model sees redacted PII and faithfully copies the placeholders back.

    Left alone, that shipped a resume whose header carried no phone and no
    email — a document no employer could reply to. Identity is therefore read off
    the RAW source locally and stamped onto every variant after the rewrite.
    """
    redacted = json.loads(json.dumps(HONEST_STRUCT))
    redacted["name"] = "[name redacted]"
    redacted["contact_line"] = "[phone redacted] | [email redacted]"
    _stub_llm(monkeypatch, redacted)

    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)
    assert result["variants"], result["reasons"]

    out = tmp_path / "variant.pdf"
    out.write_bytes(result["variants"][0]["pdf_bytes"])
    text = render_pdf.extract_back(str(out))

    assert "redacted" not in text.lower()
    assert "98765" in text
    assert "priya.sharma@example.com" in text


# --------------------------------------------------------------------------
# the three gates — the product's central guarantee
# --------------------------------------------------------------------------

def test_an_invented_skill_never_reaches_the_document(monkeypatch, tmp_path):
    """Kubernetes appears nowhere in the master. It must not appear in a variant.

    The guarantee is about the ARTEFACT, not about the batch: the invented skill
    is stripped and the candidate's real content survives. Asserting
    `variants == []` (as this test first did) demanded that one hallucinated word
    cost the user their whole rewrite, which is over-punishment dressed up as
    strictness — and it would have hidden the case where the word is removed but
    the PDF is still built from the pre-strip struct.
    """
    lying = json.loads(json.dumps(HONEST_STRUCT))
    lying["sections"][3]["items"][1]["bullets"].append("Kubernetes")
    _stub_llm(monkeypatch, lying)

    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)
    assert result["variants"], result["reasons"]
    for v in result["variants"]:
        out = tmp_path / f"{v['label']}.pdf"
        out.write_bytes(v["pdf_bytes"])
        assert "kubernetes" not in render_pdf.extract_back(str(out)).lower()


def test_the_gates_hold_against_a_deliberate_fabrication_attack(monkeypatch, tmp_path):
    """The exact attack that walked through all three gates untouched.

    Before this was closed, `_fabricated_skills` checked a 60-string vocabulary
    and bullet PROSE was never grounded at all — only numbers were. So a rewrite
    could add a skills group of seven technologies the candidate had never
    touched, plus prose claiming to have run them, and every gate returned clean.
    That is the single guarantee this product sells.
    """
    attack = {
        "name": "Priya Sharma",
        "contact_line": HONEST_STRUCT["contact_line"],
        "sections": [
            {"heading": "Experience", "items": [
                {"head": "Software Engineering Intern, Zenlytics Pvt Ltd",
                 "sub": "Jun 2025 - Aug 2025",
                 "bullets": [
                     "Built a REST API in FastAPI and PostgreSQL serving 12000 daily requests",
                     "Owned the Kafka streaming pipeline and the Terraform infrastructure end to end",
                 ]},
            ]},
            {"heading": "Technical Skills", "items": [
                {"head": "Tools", "sub": "",
                 "bullets": ["Apache Kafka", "Terraform", "Snowflake",
                             "Elasticsearch", "Jenkins", "Hadoop", "Spark"]},
            ]},
        ],
    }
    _stub_llm(monkeypatch, attack)
    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)

    invented = ["kafka", "terraform", "snowflake", "elasticsearch",
                "jenkins", "hadoop", "spark"]
    for v in result["variants"]:
        out = tmp_path / f"{v['label']}.pdf"
        out.write_bytes(v["pdf_bytes"])
        text = render_pdf.extract_back(str(out)).lower()
        for word in invented:
            assert word not in text, f"{word!r} survived into {v['label']}"
    # The real bullet is not collateral damage — an invented sentence inside a
    # real job must cost that sentence, not the job.
    if result["variants"]:
        text = render_pdf.extract_back(str(tmp_path / f"{result['variants'][0]['label']}.pdf"))
        assert "FastAPI" in text


def test_the_skills_gate_knows_more_than_sixty_technologies(monkeypatch):
    """TECH_VOCAB, not the short KNOWN_SKILLS list the gate used to read."""
    vocab = resume_optimize.TECH_VOCAB
    assert len(vocab) > 200
    for name in ("kafka", "terraform", "snowflake", "elasticsearch",
                 "jenkins", "hadoop", "spark", "kubernetes", "selenium"):
        assert name in vocab, name


def test_ordinary_rewording_is_not_flagged_as_invention():
    """The gate must not fire on a rewrite doing its job.

    Grounding every WORD would reject every honest variant — a rewrite exists to
    reword. Only named things (capitalised mid-sentence, or in the technology
    vocabulary) and numbers have to be defensible.
    """
    stems = resume_optimize._source_stems(MASTER)
    honest = [
        "Engineered a REST API in FastAPI and PostgreSQL, serving 12000 requests each day",
        "Cut median query latency from 840ms to 190ms by introducing Redis caching",
        "Authored 46 pytest cases, lifting billing coverage to 78%",
    ]
    for bullet in honest:
        assert resume_optimize.ungrounded_in_bullet(bullet, stems) == [], bullet


def test_a_rewrite_that_invents_an_employer_is_dropped(monkeypatch):
    """An entry with no ancestor on the master is an invented job."""
    lying = json.loads(json.dumps(HONEST_STRUCT))
    lying["sections"][1]["items"] = [
        {"head": "Senior Engineer, Globex Corporation",
         "sub": "Jan 2019 - Dec 2021",
         "bullets": ["Directed a distributed platform team across three continents"]},
    ]
    _stub_llm(monkeypatch, lying)

    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)
    for v in result["variants"]:
        flat = json.dumps(v).lower()
        assert "globex" not in flat
        assert "three continents" not in flat


def test_a_wholesale_hallucination_is_dropped_as_drift(monkeypatch):
    invented = {
        "name": "Priya Sharma",
        "contact_line": HONEST_STRUCT["contact_line"],
        "sections": [
            {"heading": "Experience", "items": [
                {"head": "Principal Architect, Initech", "sub": "2015 - 2024",
                 "bullets": ["Led a 40 person organisation delivering a trading platform"]},
                {"head": "Staff Engineer, Umbrella", "sub": "2012 - 2015",
                 "bullets": ["Owned the pricing service handling 2 million orders a second"]},
            ]},
        ],
    }
    _stub_llm(monkeypatch, invented)
    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)
    assert result["variants"] == []


def test_a_model_returning_nothing_is_reported_not_faked(monkeypatch):
    """No provider available must produce an honest abort, never a fabricated PDF."""
    monkeypatch.setattr(
        resume_optimize.llm_mod, "chat_json_ensemble",
        lambda *a, **k: None,
    )
    result = resume_optimize.generate_variants(MASTER, MASTER_SKILLS)
    assert result["variants"] == []
    assert result["aborted"] == "extraction_failed"


def test_bullets_are_capped_so_one_bad_response_cannot_blow_up_a_page(monkeypatch):
    """The length cap used to live in the LaTeX renderer, which no longer exists.

    Moving it into the sanitizer is what keeps it applying to the JSON the API
    returns as well as to the PDF.
    """
    huge = json.loads(json.dumps(HONEST_STRUCT))
    huge["sections"][1]["items"][0]["bullets"] = ["x" * 5000]
    cleaned = resume_optimize._sanitize_struct(huge)
    bullet = cleaned["sections"][1]["items"][0]["bullets"][0]
    assert len(bullet) <= resume_optimize._MAX_BULLET_CHARS


# --------------------------------------------------------------------------
# targeting
# --------------------------------------------------------------------------

def test_targeting_changes_the_instruction_but_not_the_gates(monkeypatch):
    _stub_llm(monkeypatch, HONEST_STRUCT)
    import companies

    pack = companies.get_pack("amazon")
    assert pack
    result = resume_optimize.generate_variants(
        MASTER, MASTER_SKILLS,
        target_keywords=pack["keywords"],
        emphasis=pack["emphasis"],
        target_name=pack["name"],
    )
    assert result["aborted"] is None
    # The coverage band is live, so the baseline now reflects the target.
    assert result["baseline_report"]["targeted"] is True


def test_emphasis_never_grants_permission_to_invent():
    """The suffix must say so in words, because it is the instruction a model reads."""
    out = resume_optimize._targeted_strategies(
        [("Test", "Do the thing.")],
        ["Surface ownership language"],
        "Amazon",
    )
    instruction = out[0][1]
    assert "NEVER permission to add" in instruction
    assert "Amazon" in instruction
