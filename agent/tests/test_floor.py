"""The shippable floor, and the repairs allowed to reach it.

The line this file guards is the one between "fix our own output" and "write the
user's resume for them". Everything `_repair_for_floor` does must be true of the
document before the repair as well as after it — a heading renamed, a skill the
candidate already claimed printed where a search will find it. Nothing here may
add a fact, and several tests exist only to prove that the tempting shortcuts
are not taken.
"""
from __future__ import annotations

import readiness
import resume_optimize as ro


# ---------------------------------------------------------------------------
# profile links recovered from the PDF's annotations
# ---------------------------------------------------------------------------

def test_a_bare_handle_is_replaced_by_the_full_url():
    """The commonest shape: the address exists only as a link annotation.

    A resume shows "mahendhar-sammeta" with the LinkedIn URL behind it. No text
    extractor sees the URL, so the fields band correctly reports no profile
    link, and an application form asking for one gets nothing.
    """
    out = ro._merge_profile_links(
        "+91 8096267553 | me@example.com | mahendhar-sammeta | mahisamm",
        ["https://www.linkedin.com/in/mahendhar-sammeta", "https://github.com/mahisamm"],
    )
    assert "linkedin.com/in/mahendhar-sammeta" in out
    assert "github.com/mahisamm" in out
    # Replaced, not appended: no "mahendhar-sammeta · linkedin.com/in/mahendhar-sammeta".
    assert out.count("mahendhar-sammeta") == 1
    assert out.count("mahisamm") == 1


def test_a_url_already_printed_as_text_is_not_added_twice():
    out = ro._merge_profile_links(
        "me@example.com | linkedin.com/in/priya",
        ["https://linkedin.com/in/priya"],
    )
    assert out.count("linkedin.com") == 1


def test_only_profile_hosts_are_printed():
    """A PDF's annotations point at everything — certificates, company sites,
    a Google Doc. Appending all of them turns a header into a link dump."""
    out = ro._merge_profile_links("me@example.com", [
        "https://acme-corp.example.com/about",
        "https://drive.google.com/file/d/xyz/view",
        "https://coursera.org/verify/ABC123",
        "https://github.com/priya",
    ])
    assert "github.com/priya" in out
    for noise in ("acme-corp", "drive.google.com", "coursera"):
        assert noise not in out


def test_one_link_per_host():
    out = ro._merge_profile_links("me@example.com", [
        "https://github.com/priya",
        "https://github.com/priya/some-repo",
        "https://github.com/priya/another-repo",
    ])
    assert out.count("github.com") == 1


def test_no_links_leaves_the_line_untouched():
    line = "+91 90000 00000 | me@example.com"
    assert ro._merge_profile_links(line, None) == line
    assert ro._merge_profile_links(line, []) == line


def test_the_header_is_capped():
    out = ro._merge_profile_links("me@example.com", [
        "https://github.com/p", "https://linkedin.com/in/p", "https://kaggle.com/p",
        "https://medium.com/@p", "https://behance.net/p", "https://orcid.org/0000",
    ])
    assert len(ro._SEP_RE.split(out)) <= 4


def test_our_own_middot_header_survives_a_round_trip():
    """A user downloads a Grindly rebuild and uploads it again.

    Our template prints fields separated by a middot. `_clean_contact_line`
    erases any character outside its allow-list, and the middot is outside it,
    so splitting has to happen first — otherwise the whole header collapses into
    one unsplittable segment and `_header_line` rejects it, losing every profile
    link on re-upload.
    """
    line = "+91 90000 00000 · priya@example.com · linkedin.com/in/priya · github.com/priya"
    kept = ro._header_line(line)
    assert "priya@example.com" in kept
    assert "linkedin.com/in/priya" in kept
    assert "github.com/priya" in kept


# ---------------------------------------------------------------------------
# headings a parser cannot classify
# ---------------------------------------------------------------------------

def test_unclassifiable_headings_are_renamed():
    struct = {"sections": [
        {"heading": "Academic Background", "items": [{"head": "B.Tech", "sub": "", "bullets": []}]},
        {"heading": "My Journey", "items": [{"head": "Intern", "sub": "", "bullets": []}]},
        {"heading": "Technical Proficiencies", "items": [{"head": "Languages", "sub": "", "bullets": ["Python"]}]},
    ]}
    renamed = ro._canonicalise_headings(struct)
    headings = [s["heading"] for s in struct["sections"]]
    assert headings == ["Education", "Experience", "Technical Skills"]
    assert len(renamed) == 3
    # Every renamed heading is one the scorer can now classify.
    found = readiness.find_sections(" ".join(headings))
    assert found["education"] and found["experience"] and found["skills"]


def test_a_heading_is_not_renamed_onto_one_that_already_exists():
    """Two sections both called "Education" is worse than one odd heading: the
    rebuild would show the same word twice and a reader would assume a bug."""
    struct = {"sections": [
        {"heading": "Education", "items": []},
        {"heading": "Academic Background", "items": []},
    ]}
    ro._canonicalise_headings(struct)
    assert [s["heading"] for s in struct["sections"]] == ["Education", "Academic Background"]


def test_standard_headings_are_left_alone():
    struct = {"sections": [
        {"heading": "Education", "items": []},
        {"heading": "Experience", "items": []},
        {"heading": "Projects", "items": []},
        {"heading": "Technical Skills", "items": []},
    ]}
    assert ro._canonicalise_headings(struct) == []


# ---------------------------------------------------------------------------
# the skills block
# ---------------------------------------------------------------------------

def test_the_skills_block_comes_from_the_candidates_own_list():
    block = ro._skills_section(["Python", "Docker", "PostgreSQL"])
    assert block["heading"] == "Technical Skills"
    assert block["items"][0]["bullets"] == ["Python", "Docker", "PostgreSQL"]


def test_no_skills_means_no_block():
    """Two skills is not a skills section, and an empty one is a heading over
    nothing. Neither is worth the repair."""
    assert ro._skills_section([]) is None
    assert ro._skills_section(["Python", "SQL"]) is None


# ---------------------------------------------------------------------------
# what the repair will and will not do
# ---------------------------------------------------------------------------

def _report(**bands) -> dict:
    """A report shaped like readiness.score()'s, with the bands under test."""
    full = {"readable": 100, "fields": 100, "structure": 100, "impact": 100}
    full.update(bands)
    weights = {"readable": 35.3, "fields": 23.5, "structure": 17.6, "impact": 23.5}
    return {
        "bands": {
            k: {"score": v, "weight": weights[k], "points": round(weights[k] * v / 100, 1)}
            for k, v in full.items()
        },
        "facts": {"structure": {"sections": {
            "education": True, "skills": True, "experience": True, "projects": True,
        }}},
        "findings": [],
    }


def test_a_missing_skills_section_is_added():
    struct = {"sections": [
        {"heading": "Experience", "items": [{"head": "Intern", "sub": "", "bullets": ["Built things."]}]},
    ]}
    report = _report(structure=60)
    report["facts"]["structure"]["sections"]["skills"] = False

    repairs = ro._repair_for_floor(struct, report, ["Python", "Docker", "SQL"])
    assert repairs
    assert [s["heading"] for s in struct["sections"]][-1] == "Technical Skills"


def test_a_skills_section_is_not_added_twice():
    struct = {"sections": [
        {"heading": "Core Competencies", "items": [{"head": "", "sub": "", "bullets": ["Python"]}]},
    ]}
    report = _report(structure=60)
    report["facts"]["structure"]["sections"]["skills"] = False
    ro._repair_for_floor(struct, report, ["Python", "Docker", "SQL"])
    assert sum(1 for s in struct["sections"] if "skill" in s["heading"].lower()
               or "competenc" in s["heading"].lower()) == 1


def test_a_perfect_structure_band_is_not_touched():
    struct = {"sections": [{"heading": "Experience", "items": []}]}
    before = [dict(s) for s in struct["sections"]]
    assert ro._repair_for_floor(struct, _report(), ["Python", "Docker", "SQL"]) == []
    assert struct["sections"] == before


def test_the_repair_never_invents_content_for_the_bands_it_cannot_fix():
    """impact and readable are the candidate's, not ours.

    A resume whose bullets state no outcomes scores low on impact, and the only
    way to raise it is to write outcomes. The repair must decline: a floor
    reached by making up a metric is a fabrication with a number attached.
    """
    struct = {"sections": [
        {"heading": "Experience",
         "items": [{"head": "Intern", "sub": "", "bullets": ["Worked on various tasks."]}]},
        {"heading": "Education", "items": [{"head": "B.Tech", "sub": "", "bullets": []}]},
        {"heading": "Technical Skills", "items": [{"head": "Languages", "sub": "", "bullets": ["Python"]}]},
    ]}
    import copy
    before = copy.deepcopy(struct)
    repairs = ro._repair_for_floor(struct, _report(impact=10, readable=40), ["Python", "Docker", "SQL"])
    assert repairs == []
    assert struct == before


# ---------------------------------------------------------------------------
# explaining the gap
# ---------------------------------------------------------------------------

def test_the_gap_names_the_band_that_costs_the_most():
    report = _report(impact=20, fields=90)
    report["findings"] = [
        {"band": "fields", "severity": "warning", "problem": "no links", "fix": "add your github url"},
        {"band": "impact", "severity": "warning", "problem": "no numbers", "fix": "add the real figures you know"},
    ]
    # impact is short by ~19 points, fields by ~2. The advice must be about impact.
    assert ro._floor_gap(report) == "add the real figures you know"


def test_the_gap_is_empty_when_nothing_is_short():
    assert ro._floor_gap(_report()) == ""


def test_the_floor_is_above_what_the_mechanical_bands_alone_can_earn():
    """The floor must not be clearable by an empty document rendered cleanly.

    readable + fields + structure are properties of our template. If the floor
    sat at or below their combined weight, "every resume scores 80+" would be a
    statement about our stylesheet rather than about anybody's resume.
    """
    weights = readiness._weights(has_jd=False)
    mechanical = weights["readable"] + weights["fields"] + weights["structure"]
    assert mechanical < readiness.SHIPPABLE_FLOOR
    assert readiness.SHIPPABLE_FLOOR < mechanical + weights["impact"] * 0.5
