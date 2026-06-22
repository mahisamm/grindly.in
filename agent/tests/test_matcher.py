import json

import matcher


def test_score_rewards_skill_overlap():
    job = {"title": "Frontend React Intern", "company": "Acme", "skills": ["react", "javascript"]}
    score, reason = matcher.score_job(job, ["react", "javascript", "css"], ["web development"])
    assert score >= 55
    assert "react" in reason


def test_firewall_blocks_excluded_company():
    job = {"company": "Acme Corp Ltd", "location": "Remote"}
    profile = {"excluded_companies": json.dumps(["Acme"])}
    assert matcher.firewall_block(job, profile) is not None


def test_firewall_blocks_non_remote_when_remote_required():
    job = {"company": "X", "location": "Bengaluru"}
    profile = {"work_mode": "remote"}
    assert matcher.firewall_block(job, profile) == "not remote"


def test_firewall_blocks_low_stipend():
    job = {"company": "X", "location": "Remote", "stipend": "5000"}
    profile = {"stipend_min": 10000}
    assert matcher.firewall_block(job, profile) is not None


def test_firewall_allows_clean_job():
    job = {"company": "GoodCo", "location": "Remote", "stipend": "20000"}
    profile = {"excluded_companies": "[]", "work_mode": "remote", "stipend_min": 10000}
    assert matcher.firewall_block(job, profile) is None
