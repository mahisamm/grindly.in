"""The whole pipeline, end to end, with the model pinned.

Every other test file measures one stage. This one runs the real thing —
extract, rewrite, three gates, render with Chromium, read the PDF back, score
it, repair it if it is under the floor — and asserts on the artefact a user
would actually download.

The model is stubbed, not mocked out: `chat_ensemble` returns fixed JSON, so
these tests are deterministic and offline while everything downstream of the
model is genuinely exercised. That boundary is the right one because every bug
this file has caught lived downstream of it.
"""
from __future__ import annotations

import json

import pytest

import llm as llm_mod
import readiness
import render_pdf
import resume_optimize as ro

pytestmark = pytest.mark.slow


SENIOR_RESUME = """Priya Ramanathan
+91 98765 43210 | priya.ramanathan@example.com | Bengaluru, India | priya-ramanathan

PROFESSIONAL SUMMARY
Backend engineer with seven years on payment systems, most recently owning
settlement for a platform processing 40000 transactions a day.

EXPERIENCE
Senior Software Engineer, Acme Payments, Bengaluru | Jan 2021 - Present
- Rebuilt the settlement pipeline in Java and Kafka, cutting reconciliation from 6 hours to 40 minutes
- Led 4 engineers through a migration to event-driven processing
- Introduced contract tests across 9 services, taking release rollbacks from 3 a month to 0
Backend Engineer, Northwind Systems, Pune | Jun 2018 - Dec 2020
- Built the internal reporting service in Python and PostgreSQL, used by 300 staff daily
- Automated release verification, removing 12 hours of manual testing per week
- Migrated 40 batch jobs off cron onto a scheduler with retries and alerting

EDUCATION
B.E. Computer Science, Pune University | 2014 - 2018 | CGPA 8.4/10

TECHNICAL SKILLS
Languages: Java, Python, SQL
Platform: AWS, Docker, Kubernetes, Kafka, PostgreSQL, Redis
"""

SENIOR_SKILLS = ["java", "python", "sql", "aws", "docker", "kubernetes",
                 "kafka", "postgresql", "redis"]

EXTRACTED = {
    "name": "Priya Ramanathan",
    "contact_line": "priya.ramanathan@example.com | +91 98765 43210 | Bengaluru, India | priya-ramanathan",
    "sections": [
        {"heading": "Professional Summary", "items": [
            {"head": "", "sub": "", "bullets": [
                "Backend engineer with seven years on payment systems, most recently "
                "owning settlement for a platform processing 40000 transactions a day.",
            ]},
        ]},
        {"heading": "Experience", "items": [
            {"head": "Senior Software Engineer",
             "sub": "Acme Payments | Jan 2021 - Present | Bengaluru",
             "bullets": [
                 "Rebuilt the settlement pipeline in Java and Kafka, cutting reconciliation from 6 hours to 40 minutes",
                 "Led 4 engineers through a migration to event-driven processing",
                 "Introduced contract tests across 9 services, taking release rollbacks from 3 a month to 0",
             ]},
            {"head": "Backend Engineer",
             "sub": "Northwind Systems | Jun 2018 - Dec 2020 | Pune",
             "bullets": [
                 "Built the internal reporting service in Python and PostgreSQL, used by 300 staff daily",
                 "Automated release verification, removing 12 hours of manual testing per week",
                 "Migrated 40 batch jobs off cron onto a scheduler with retries and alerting",
             ]},
        ]},
        {"heading": "Education", "items": [
            {"head": "B.E. Computer Science",
             "sub": "Pune University | 2014 - 2018 | CGPA 8.4/10", "bullets": []},
        ]},
        {"heading": "Technical Skills", "items": [
            {"head": "Languages", "sub": "", "bullets": ["Java", "Python", "SQL"]},
            {"head": "Platform", "sub": "",
             "bullets": ["AWS", "Docker", "Kubernetes", "Kafka", "PostgreSQL", "Redis"]},
        ]},
    ],
}


def _rewrite_of(struct: dict, changes: list[str] | None = None) -> str:
    return json.dumps({
        "resume": struct,
        "changes": changes or [
            "Led every bullet with a past-tense action verb",
            "Moved the real figures to the front of each outcome",
            "Named the stack in the bullet as well as in Technical Skills",
        ],
    })


@pytest.fixture
def model(monkeypatch):
    """Pin `chat_ensemble`, routing by which system prompt it was handed.

    `rewrites` may be a single struct or a list; a list lets one test give the
    three strategies genuinely different answers, which is how the real thing
    behaves and how the "richest surviving response wins" logic gets exercised.
    """
    def _set(extracted=EXTRACTED, rewrites=None):
        rewrites = rewrites if rewrites is not None else EXTRACTED
        queue = list(rewrites) if isinstance(rewrites, list) else None

        def fake(prompt, system="", n=3, timeout=60, **kw):
            if "structured JSON" in system or "converts" in system.lower():
                return [json.dumps(extracted)] * min(n, 3)
            nonlocal queue
            if queue is not None:
                struct = queue.pop(0) if queue else EXTRACTED
            else:
                struct = rewrites
            return [_rewrite_of(struct)] * min(n, 3)

        monkeypatch.setattr(llm_mod, "chat_ensemble", fake)
        monkeypatch.setattr(ro.llm_mod, "chat_ensemble", fake)
    return _set


requires_chromium = pytest.mark.skipif(
    not render_pdf.renderer_available(), reason="playwright/chromium not installed"
)


# ---------------------------------------------------------------------------
# the happy path, on a resume that is not a student's
# ---------------------------------------------------------------------------

@requires_chromium
def test_an_experienced_resume_produces_variants_that_clear_the_floor(model):
    model()
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)

    assert out["aborted"] is None, out["reasons"]
    assert out["variants"], out["reasons"]
    assert out["floor"] == readiness.SHIPPABLE_FLOOR

    for v in out["variants"]:
        assert v["score"] >= readiness.SHIPPABLE_FLOOR, (v["label"], v["score"], v["floor_gap"])
        assert v["meets_floor"] is True
        assert v["floor_gap"] == ""
        assert v["pages"] == 1
        assert v["pdf_bytes"][:4] == b"%PDF"
        # readable and structure are entirely ours — text surviving extraction,
        # standard headings, real bullets, one column — so anything short of
        # full marks on them is a bug in the template.
        for band in ("readable", "structure"):
            assert v["report"]["bands"][band]["score"] == 100, (v["label"], band)
        # `fields` is only partly ours: we can lose nothing the source had, but
        # we cannot award the profile-link credit to a resume that carries no
        # profile link. So the test is that the rebuild never goes backwards.
        assert (v["report"]["bands"]["fields"]["score"]
                >= out["baseline_report"]["bands"]["fields"]["score"]), v["label"]
    assert out["meets_floor"] is True


@requires_chromium
def test_the_rendered_variant_keeps_the_candidates_real_identity(model, tmp_path):
    """Identity is stamped locally and never taken from the model.

    The LLM boundary redacts PII, so a model asked for the phone number returns
    "[phone redacted]" — and did, in a shipped variant whose header carried no
    way to contact its owner.
    """
    model(rewrites={**EXTRACTED,
                    "name": "[name redacted]",
                    "contact_line": "[email redacted] | [phone redacted]"})
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert out["variants"], out["reasons"]

    pdf = tmp_path / "v.pdf"
    pdf.write_bytes(out["variants"][0]["pdf_bytes"])
    back = render_pdf.extract_back(str(pdf))

    assert "Priya Ramanathan" in back
    assert "priya.ramanathan@example.com" in back
    assert readiness.find_phones(back), "the phone number is missing from the rebuild"
    assert "redacted" not in back.lower()


@requires_chromium
def test_a_profile_url_from_the_pdf_annotations_reaches_the_page(model, tmp_path):
    """The resume shows a bare handle; the URL exists only as a link annotation."""
    model()
    out = ro.generate_variants(
        SENIOR_RESUME, SENIOR_SKILLS,
        source_links=["https://www.linkedin.com/in/priya-ramanathan",
                      "https://github.com/priya-r"],
    )
    assert out["variants"], out["reasons"]
    pdf = tmp_path / "v.pdf"
    pdf.write_bytes(out["variants"][0]["pdf_bytes"])
    back = render_pdf.extract_back(str(pdf))

    links = " ".join(readiness.find_links(back))
    assert "linkedin.com/in/priya-ramanathan" in links
    assert "github.com/priya-r" in links
    # Replaced the bare handle rather than printing beside it.
    assert back.count("priya-ramanathan") <= 2


# ---------------------------------------------------------------------------
# the gates, exercised through the real pipeline rather than in isolation
# ---------------------------------------------------------------------------

@requires_chromium
def test_an_invented_employer_never_reaches_a_pdf(model):
    fabricated = json.loads(json.dumps(EXTRACTED))
    fabricated["sections"][1]["items"].append({
        "head": "Staff Engineer",
        "sub": "Google | Jan 2017 - May 2018 | Hyderabad",
        "bullets": ["Scaled a globally distributed cache to 2 million requests per second"],
    })
    model(rewrites=fabricated)

    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    for v in out["variants"]:
        joined = json.dumps(v["report"]["facts"]) + " ".join(v["changes"])
        assert "Google" not in joined
    # And nothing invented survived into the document itself.
    assert out["variants"], out["reasons"]


@requires_chromium
def test_an_invented_skill_is_stripped_out_of_the_shipped_variant(model, tmp_path):
    """Two gates can catch this and the gentler one gets there first.

    Grounding removes the invented entries item by item, so a rewrite that adds
    Rust and Scala to a skills list loses those two lines and keeps the rest.
    That is the better outcome than dropping the whole variant — the user gets
    an honest rewrite instead of nothing — and it is only acceptable because the
    result is checked here on the rendered PDF rather than on the struct.
    """
    fabricated = json.loads(json.dumps(EXTRACTED))
    fabricated["sections"][3]["items"][0]["bullets"] = ["Java", "Python", "SQL", "Rust", "Scala"]
    model(rewrites=fabricated)

    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert out["variants"], out["reasons"]
    assert any("not in your resume" in r or "invented" in r for r in out["reasons"]), out["reasons"]

    pdf = tmp_path / "v.pdf"
    pdf.write_bytes(out["variants"][0]["pdf_bytes"])
    back = render_pdf.extract_back(str(pdf))
    assert "Rust" not in back and "Scala" not in back
    assert "Java" in back and "Python" in back


@requires_chromium
def test_a_wholesale_hallucination_is_dropped_as_drift(model):
    model(rewrites={
        "name": "Priya Ramanathan",
        "contact_line": "priya.ramanathan@example.com",
        "sections": [
            {"heading": "Experience", "items": [
                {"head": "AI Engineer", "sub": "XYZ Corp | 2019 - 2024",
                 "bullets": ["Delivered enterprise machine learning platforms"]},
            ]},
            {"heading": "Education", "items": [
                {"head": "MSc Data Science", "sub": "University of Technology | 2017 - 2019",
                 "bullets": []},
            ]},
        ],
    })
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert not out["variants"]
    assert any("drift" in r or "invented" in r for r in out["reasons"]), out["reasons"]


# ---------------------------------------------------------------------------
# the floor repair
# ---------------------------------------------------------------------------

# A resume with no skills section anywhere — the shape the repair exists for.
# Not a developer's, deliberately: this product is for anyone applying for a
# job, and an operations analyst's resume must go through the same pipeline as
# a backend engineer's.
NO_SKILLS_RESUME = """Rahul Mehta
+91 90000 11111 | rahul.mehta@example.com | Pune, India

EXPERIENCE
Operations Analyst, Bluepeak Logistics, Pune | Mar 2019 - Present
- Managed daily dispatch planning across 12 depots in Excel and SQL
- Reduced idle fleet time by 18 percent by rebuilding the routing model
- Trained 6 new analysts on the data analysis and reporting process
- Cut the monthly close from 5 days to 2 days by automating the reconciliation

EDUCATION
B.Com Accounting, Pune University | 2015 - 2018 | 74 percent
"""

NO_SKILLS_EXTRACTED = {
    "name": "Rahul Mehta",
    "contact_line": "rahul.mehta@example.com | +91 90000 11111 | Pune, India",
    "sections": [
        {"heading": "Experience", "items": [
            {"head": "Operations Analyst",
             "sub": "Bluepeak Logistics | Mar 2019 - Present | Pune",
             "bullets": [
                 "Managed daily dispatch planning across 12 depots in Excel and SQL",
                 "Reduced idle fleet time by 18 percent by rebuilding the routing model",
                 "Trained 6 new analysts on the data analysis and reporting process",
                 "Cut the monthly close from 5 days to 2 days by automating the reconciliation",
             ]},
        ]},
        {"heading": "Education", "items": [
            {"head": "B.Com Accounting",
             "sub": "Pune University | 2015 - 2018 | 74 percent", "bullets": []},
        ]},
    ],
}


@requires_chromium
def test_a_resume_with_no_skills_section_gets_one_built_from_its_own_skills(model, tmp_path):
    """The one repair that is allowed: printing back a claim already made.

    A resume that names Excel and SQL only inside a bullet has made the claim —
    a recruiter's keyword search just will not find it, because the search looks
    at the skills block. The repair moves the claim, it does not create one:
    the list comes from `extract_skills`, which is the same allow-list every
    fabrication gate checks rewrites against.
    """
    model(extracted=NO_SKILLS_EXTRACTED, rewrites=NO_SKILLS_EXTRACTED)
    skills = ["excel", "sql", "data analysis"]

    out = ro.generate_variants(NO_SKILLS_RESUME, skills)
    assert out["variants"], out["reasons"]
    v = out["variants"][0]

    pdf = tmp_path / "v.pdf"
    pdf.write_bytes(v["pdf_bytes"])
    back = render_pdf.extract_back(str(pdf))

    assert readiness.find_sections(back)["skills"], "no skills section was built"
    for skill in skills:
        assert skill.lower() in back.lower(), skill
    # And the repair is reported, not applied silently — the user is told their
    # document changed shape.
    assert any("Technical Skills" in c or "machine readability" in c for c in v["changes"]), v["changes"]


@requires_chromium
def test_the_repair_is_reported_only_when_it_actually_helped(model):
    """A repair that does not move the number is not announced as a win."""
    model()
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert out["variants"], out["reasons"]
    for v in out["variants"]:
        # This resume already clears the floor, so no repair ran and none is claimed.
        assert not any("machine readability" in c for c in v["changes"]), v["changes"]


# A weak resume: no numbers, filler verbs, no skills section, and thin. The
# rebuild can make it parse perfectly and still not make it good, which is
# exactly the case the floor exists to be honest about.
WEAK_RESUME = """Anita Desai
+91 90000 22222 | anita.desai@example.com | Nagpur, India

EXPERIENCE
Store Manager, Rangoli Retail, Nagpur | 2019 - 2024
- Responsible for various daily store operations and staff scheduling
- Worked on improving customer satisfaction and handling escalations
- Involved in stock management, vendor coordination and data analysis in Excel and SQL

EDUCATION
BA Economics, Nagpur University | 2015 - 2018
"""

WEAK_EXTRACTED = {
    "name": "Anita Desai",
    "contact_line": "anita.desai@example.com | +91 90000 22222 | Nagpur, India",
    "sections": [
        {"heading": "Experience", "items": [
            {"head": "Store Manager", "sub": "Rangoli Retail | 2019 - 2024 | Nagpur",
             "bullets": [
                 "Responsible for various daily store operations and staff scheduling",
                 "Worked on improving customer satisfaction and handling escalations",
                 "Involved in stock management, vendor coordination and data analysis in Excel and SQL",
             ]},
        ]},
        {"heading": "Education", "items": [
            {"head": "BA Economics", "sub": "Nagpur University | 2015 - 2018", "bullets": []},
        ]},
    ],
}


@requires_chromium
def test_a_variant_under_the_floor_says_which_one_thing_is_missing(model):
    """The floor is a promise about honesty, not about the number.

    A resume whose bullets state no outcomes cannot be lifted over 80 by any
    repair that does not write content, and writing content is the one thing
    this pipeline must never do. So the rebuild is still shipped — it is a real
    improvement on the original and it parses cleanly — but it is labelled as
    under the bar and carries the single most useful sentence about why.

    The alternative, shipping it at 68 with nothing said, is how every other
    tool in this category works and it is the reason none of them can be
    checked.
    """
    model(extracted=WEAK_EXTRACTED, rewrites=WEAK_EXTRACTED)
    out = ro.generate_variants(WEAK_RESUME, ["excel", "sql", "data analysis"])

    assert out["variants"], out["reasons"]
    v = out["variants"][0]
    assert v["score"] > v["baseline_score"], "the rebuild should still beat the original"
    assert v["score"] < readiness.SHIPPABLE_FLOOR, (
        "this fixture is meant to land under the floor; if it no longer does, "
        "the scorer moved and this test needs a weaker resume"
    )
    assert v["meets_floor"] is False
    assert len(v["floor_gap"]) > 20, "under the floor with nothing to say about why"
    assert out["meets_floor"] is False
    assert out["floor_gap"] == v["floor_gap"]
    # The advice must be about the content, since the layout is already ours.
    assert any(word in v["floor_gap"].lower()
               for word in ("number", "figure", "verb", "bullet", "outcome")), v["floor_gap"]


# ---------------------------------------------------------------------------
# targeting
# ---------------------------------------------------------------------------

@requires_chromium
def test_a_rewrite_that_tightens_away_half_the_content_is_dropped(model):
    """Compression is not cleanup.

    Measured on production: two of three rewrites of a strong 1,035-character
    resume came back at 790 characters, having deleted the Professional Summary
    and pared every bullet past the point where it named a tool. They scored
    below the master and were discarded — correctly, but only after a full
    render each, and the user was told "nothing beat your resume" when what had
    actually happened is that their summary was thrown away.
    """
    gutted = json.loads(json.dumps(EXTRACTED))
    gutted["sections"] = [s for s in gutted["sections"]
                          if s["heading"] != "Professional Summary"]
    for section in gutted["sections"]:
        for item in section["items"]:
            if item["bullets"] and section["heading"] != "Technical Skills":
                item["bullets"] = item["bullets"][:1]
    model(rewrites=gutted)

    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert not out["variants"], "a rewrite that deleted half the bullets was shipped"
    assert any("lost" in r and "bullet" in r for r in out["reasons"]), out["reasons"]


@requires_chromium
def test_regrouping_the_skills_block_is_not_content_loss(model):
    """The false positive the guard has to avoid.

    Six one-word bullets under "Languages" legitimately become one line reading
    "Languages: Python, SQL, Java". Counting skills bullets would read every
    good skills rewrite as content loss and drop it.
    """
    regrouped = json.loads(json.dumps(EXTRACTED))
    regrouped["sections"][3]["items"] = [{
        "head": "", "sub": "",
        "bullets": ["Languages: Java, Python, SQL",
                    "Platform: AWS, Docker, Kubernetes, Kafka, PostgreSQL, Redis"],
    }]
    model(rewrites=regrouped)

    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert out["variants"], out["reasons"]
    assert not any("lost" in r and "bullet" in r for r in out["reasons"]), out["reasons"]


@requires_chromium
def test_targeting_scores_coverage_without_adding_anything(model):
    model()
    wanted = ["java", "kafka", "kubernetes", "rust", "scala", "erlang"]
    out = ro.generate_variants(
        SENIOR_RESUME, SENIOR_SKILLS,
        target_keywords=wanted,
        emphasis=["Lead with distributed systems work."],
        target_name="Acme",
    )
    assert out["variants"], out["reasons"]
    coverage = out["variants"][0]["report"]["facts"]["coverage"]
    assert set(coverage["covered"]) == {"java", "kafka", "kubernetes"}
    # The three she does not have are reported as missing, never supplied.
    assert set(coverage["missing"]) == {"rust", "scala", "erlang"}


@requires_chromium
def test_a_targeted_run_ships_the_company_shaped_version_even_when_it_loses(model):
    """A master that already scores high must not switch the Target feature off.

    The user pressed "Tailor for Acme" wanting the Acme-shaped version of their
    resume, not a contest against their own number. Under the old rule a 95
    master silently discarded every tailored rebuild and answered "nothing beat
    your resume — good sign", which reads as the feature refusing to work. Now
    the best rebuild ships anyway — exactly one, flagged materially_worse and
    carrying both numbers — while the untargeted Rewrite tab keeps the strict
    rule, because there the score is the whole point.
    """
    import re

    # Strip the figures out of every bullet: same structure, same content
    # shape (so the content-loss guard stays quiet), strictly lower impact
    # band — a rewrite that genuinely loses to a quantified master.
    numberless = json.loads(json.dumps(EXTRACTED))
    for section in numberless["sections"]:
        for item in section["items"]:
            item["bullets"] = [re.sub(r"\d+", "several", b) for b in item["bullets"]]
    model(rewrites=numberless)

    # Untargeted: the strict rule holds — nothing below the master ships.
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert not out["variants"], "a numberless rewrite shipped against a quantified master"

    # Targeted: the same losing rewrites still yield ONE company-shaped doc.
    out = ro.generate_variants(
        SENIOR_RESUME, SENIOR_SKILLS,
        target_keywords=["java", "kafka"],
        target_name="Acme",
    )
    assert len(out["variants"]) == 1, out["reasons"]
    v = out["variants"][0]
    assert v["score"] < v["baseline_score"], "fixture meant to lose; scorer moved?"
    assert v["materially_worse"] is True
    assert v["beats_baseline"] is False
    # The audit trail says kept-for-the-target, not discarded.
    assert any("shaped for Acme" in r for r in out["reasons"]), out["reasons"]


# ---------------------------------------------------------------------------
# refusals
# ---------------------------------------------------------------------------

def test_a_resume_too_short_to_rebuild_is_refused_before_any_model_call(monkeypatch):
    def explode(*a, **k):
        raise AssertionError("the model was called for a 40-character resume")
    monkeypatch.setattr(ro.llm_mod, "chat_ensemble", explode)

    out = ro.generate_variants("Priya Ramanathan\nBengaluru", [])
    assert out["aborted"] == "source_too_short"
    assert out["variants"] == []


@requires_chromium
def test_an_extraction_that_returns_nothing_aborts_rather_than_inventing(model):
    """The most dangerous failure in the module, and the one that shipped.

    An empty extraction is not "a thin resume" — it is a model being handed a
    blank document and asked to improve it, which it does by writing a career.
    """
    model(extracted={"name": "", "contact_line": "", "sections": []})
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert out["aborted"] == "extraction_failed"
    assert out["variants"] == []


# ---------------------------------------------------------------------------
# the one-page budget
# ---------------------------------------------------------------------------

def _long_struct(n_roles: int = 14) -> dict:
    """A resume that cannot fit one page: many roles, three bullets each."""
    roles = [{
        "head": f"Software Engineer {i}",
        "sub": f"Company {i} | Jan 20{10 + i % 10} - Dec 20{11 + i % 10} | Pune",
        "bullets": [
            f"Built the reporting service in Python and PostgreSQL, used by {300 + i} staff daily",
            f"Automated release verification, removing {10 + i} hours of manual testing per week",
            f"Migrated {30 + i} batch jobs off cron onto a scheduler with retries and alerting",
        ],
    } for i in range(n_roles)]
    s = json.loads(json.dumps(EXTRACTED))
    s["sections"][1]["items"] = roles
    return s


@requires_chromium
def test_a_page_budget_is_measured_and_reported_honestly(model):
    """The user chose one page. The model (stubbed) cannot shorten — it returns
    the same long resume to the tightening pass too — so the document still
    renders at two pages. It must SHIP, flagged over budget, with the change
    list saying so, rather than be dropped or silently cut.
    """
    long = _long_struct()
    model(extracted=long, rewrites=long)
    text = "\n".join(
        f"{it['head']}, {it['sub']}\n" + "\n".join("- " + b for b in it["bullets"])
        for it in long["sections"][1]["items"]
    ) + "\nTechnical Skills: Java, Python, SQL, AWS, Docker, Kubernetes, Kafka, PostgreSQL, Redis\n"
    out = ro.generate_variants(text, SENIOR_SKILLS, max_pages=1)
    assert out["page_budget"] == 1
    assert out["variants"], out["reasons"]
    v = out["variants"][0]
    assert v["page_budget"] == 1
    assert v["pages"] >= 2
    assert v["over_budget"] is True
    assert any("page" in c.lower() and "budget" in c.lower() for c in v["changes"]), v["changes"]


@requires_chromium
def test_without_a_budget_nothing_about_pages_is_claimed(model):
    model()
    out = ro.generate_variants(SENIOR_RESUME, SENIOR_SKILLS)
    assert out["page_budget"] is None
    assert out["variants"], out["reasons"]
    assert out["variants"][0]["over_budget"] is False
