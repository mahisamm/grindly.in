import json

import safety


def test_can_apply_blocks_firewall():
    job = {"company": "Acme", "location": "Remote"}
    profile = {"excluded_companies": json.dumps(["Acme"]), "min_match_score": 50}
    ok, reason = safety.can_apply(job, profile, score=90)
    assert ok is False
    assert reason


def test_can_apply_blocks_low_score():
    job = {"company": "GoodCo", "location": "Remote"}
    profile = {"excluded_companies": "[]", "min_match_score": 55}
    ok, reason = safety.can_apply(job, profile, score=40)
    assert ok is False


def test_can_apply_allows_good_job():
    job = {"company": "GoodCo", "location": "Remote"}
    profile = {"excluded_companies": "[]", "min_match_score": 55, "work_mode": "any"}
    ok, reason = safety.can_apply(job, profile, score=80)
    assert ok is True
    assert reason is None


def test_session_ok_detects_login_url():
    class FakePage:
        url = "https://www.linkedin.com/login"
    assert safety.session_ok(FakePage()) is False


def test_session_ok_passes_normal_url():
    class FakePage:
        url = "https://www.linkedin.com/jobs"
    assert safety.session_ok(FakePage()) is True


def test_skills_claimed_subset_of_master():
    claimed = safety.skills_claimed("Skilled in React and Python", ["react", "python", "rust"])
    assert "react" in claimed and "python" in claimed
    assert "rust" not in claimed
