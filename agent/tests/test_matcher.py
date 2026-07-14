import json

import matcher


def test_score_rewards_skill_overlap():
    job = {"title": "Frontend React Intern", "company": "Acme", "skills": ["react", "javascript"]}
    score, reason = matcher.score_job(job, ["react", "javascript", "css"], ["web development"])
    assert score >= 55
    assert "react" in reason


# --- breadth must not be a penalty ------------------------------------------
# The scorer divided the candidate's skill hits by their TOTAL skill count, so a
# strong applicant scored *lower* than a narrow one on the identical job: a real
# 17-skill user got 21 on a Full Stack listing where a 3-skill user got 88, and a
# live run against 49 Internshala listings matched zero of them.

FULL_STACK = {
    "title": "Full Stack Development Internship",
    "company": "Acme",
    "skills": ["react", "node", "javascript", "mongodb"],
}
NARROW = ["react", "node", "javascript"]
BROAD = NARROW + [
    "mongodb", "python", "sql", "html", "css", "git", "docker", "aws",
    "typescript", "express", "linux", "pandas", "figma", "java",
]


def test_extra_skills_never_lower_the_score():
    narrow, _ = matcher.score_job(FULL_STACK, NARROW, ["web development"])
    broad, _ = matcher.score_job(FULL_STACK, BROAD, ["web development"])
    assert broad >= narrow


def test_strong_candidate_clears_the_default_threshold():
    score, _ = matcher.score_job(FULL_STACK, BROAD, ["web development"])
    assert score >= 65  # profiles.min_match_score default


def test_unknown_role_skills_do_not_count_as_a_miss():
    """An empty job["skills"] means "we couldn't read the requirements", not "the
    candidate has none of them" — it must not be scored as 0% coverage. The
    Internshala scraper used to return a literal ["communication"] placeholder for
    any title it didn't recognise, which the matcher then read as a real
    requirement the candidate lacked."""
    unknown = {"title": "React JS Development Internship", "company": "Acme", "skills": []}
    mismatched = {"title": "React JS Development Internship", "company": "Acme",
                  "skills": ["accounting", "corporate law"]}
    known = {"title": "React JS Development Internship", "company": "Acme",
             "skills": ["react", "javascript"]}

    assert matcher.score_job(unknown, BROAD, ["web development"])[0] > \
        matcher.score_job(mismatched, BROAD, ["web development"])[0]
    # and knowing the requirements — which this candidate meets — is better still
    assert matcher.score_job(known, BROAD, ["web development"])[0] > \
        matcher.score_job(unknown, BROAD, ["web development"])[0]


def test_js_in_a_title_matches_a_javascript_resume():
    """"React JS Development Internship" is one of the commonest titles on
    Internshala, and its "js" token matched no skill at all."""
    job = {"title": "React JS Development Internship", "company": "Acme", "skills": []}
    assert "javascript" in matcher.score_job(job, ["javascript"], [])[1]


def test_reading_the_jd_can_only_help():
    """The semantic term used to be a blend (0.70*base + 0.30*semantic). Cosine
    between a bag of skill words and prose is structurally low, so fetching the
    job description almost always *lowered* the score — the one signal that could
    rescue a borderline listing could only hurt it."""
    jd = ("We are looking for a full stack intern comfortable with react, node "
          "and mongodb to build and ship customer-facing features.")
    without, _ = matcher.score_job(FULL_STACK, BROAD, ["web development"])
    with_jd, _ = matcher.score_job(FULL_STACK, BROAD, ["web development"], jd_text=jd)
    assert with_jd >= without


def test_domain_bonus_needs_the_whole_phrase():
    """`any token overlaps` fired on the word "development" alone, so every
    "<Anything> Development Internship" collected the domain bonus."""
    job = {"title": "Marketing Development Internship", "company": "Acme", "skills": []}
    on_domain = matcher.score_job(job, ["marketing"], ["web development"])[0]
    assert on_domain < 65


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
