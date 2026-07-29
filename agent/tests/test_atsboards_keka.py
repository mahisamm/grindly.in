"""Keka — the first Indian ATS in the board list.

Every vendor above it in BOARDS is where a foreign-headquartered company posts.
A Bangalore startup posts here, which made the whole source blind to exactly the
employers this product exists to reach.

Two things about Keka's payload are unlike the others and are what these pin:
it is addressed by an opaque per-organisation GUID rather than by the subdomain,
and several of its fields are Python reprs embedded in JSON strings.
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import atsboards


JOB = {
    "id": "134885",
    "title": "Software Development Engineer Intern",
    "description": "<p>Build things in <b>Python</b>.</p>",
    "excerpt": "Roles and Responsibilities",
    "jobLocations": "[{'id': 181, 'name': 'Bangalore', 'city': 'Bangalore', "
                    "'state': 'KA', 'countryCode': 'IN'}]",
    "skillNames": "['Python', 'SQL']",
    "publishedOn": "2026-07-15T10:19:32.653Z",
}


def test_a_posting_becomes_an_address_we_can_apply_at():
    out = atsboards._postings("keka", {"name": "SatSure", "jobs": [JOB]}, "satsure")
    assert len(out) == 1
    assert out[0]["url"] == "https://satsure.keka.com/careers/jobdetails/134885"
    assert out[0]["job_id"] == "134885"


def test_the_employer_name_comes_from_the_portal_not_the_address():
    # caterpillar.keka.com is Group Bayport; 100.keka.com is an NGO called
    # Bright Future. Reading the company off the slug would put the wrong
    # employer on the dashboard and into the letter addressed to them.
    out = atsboards._postings("keka", {"name": "Group Bayport", "jobs": [JOB]}, "caterpillar")
    assert out[0]["company"] == "Group Bayport"


def test_a_board_still_works_while_the_old_cache_shape_is_warm():
    # The six-hour cache outlives a deploy. Refusing the bare list it is still
    # holding would blank every Keka board until it expired.
    assert atsboards._postings("keka", [JOB], "ketto")[0]["company"] == "ketto"


def test_kekas_own_demo_tenant_is_not_in_the_rotation():
    # 129 India-shaped openings, duplicated rows, and an application nobody
    # will ever read.
    assert "salesdemo" not in atsboards.BOARDS["keka"]


def test_a_python_repr_location_still_reads_as_an_indian_city():
    # jobLocations arrives as "[{'city': 'Bangalore', ...}]" — single quotes, not
    # JSON. Parsed naively it raises, and the India gate then drops every real
    # posting on the board over a quoting style.
    out = atsboards._postings("keka", {"name": "SatSure", "jobs": [JOB]}, "satsure")
    assert out[0]["location"] == "Bangalore"
    assert atsboards._INDIA.search(out[0]["location"])


def test_two_cities_are_not_repeated_once_per_key():
    raw = ("[{'name': 'Mumbai', 'city': 'Mumbai'}, "
           "{'name': 'Pune', 'city': 'Pune'}]")
    assert atsboards._keka_places(raw) == "Mumbai, Pune"


def test_skills_reach_the_text_the_matcher_scores():
    # An unparsed skills list is a posting that looks irrelevant to a candidate
    # who is a perfect fit for it.
    jd = atsboards._postings("keka", {"name": "SatSure", "jobs": [JOB]}, "satsure")[0]["jd"]
    assert "Python" in jd and "SQL" in jd


def test_a_posting_with_no_id_is_dropped_rather_than_given_a_broken_url():
    assert atsboards._postings("keka", {"name": "SatSure", "jobs": [{"title": "Intern"}]}, "satsure") == []


def test_a_keka_url_teaches_us_the_whole_board():
    # One posting found on the open web should add the company's entire board to
    # the rotation, the same way a Workable link does.
    found = atsboards.slugs_from_urls(
        ["https://vyaparapp.keka.com/careers/jobdetails/1234"]
    )
    assert ("keka", "vyaparapp") in found


def test_the_org_id_is_read_from_the_asset_path():
    # Keka publishes the id nowhere as a field; it appears inside the portal's
    # asset paths, which is the only place to read it from outside.
    blob = '{"careersBackgroundPath":"/ats/documents/305b76d0-42c4-4ad9-b650-4200e991ca4e/careerportal/x.png"}'
    m = atsboards._KEKA_GUID.search(blob)
    assert m and m.group(1) == "305b76d0-42c4-4ad9-b650-4200e991ca4e"
