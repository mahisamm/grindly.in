"""Turning a candidate into the job titles employers actually post.

The bug these exist for: a resume full of YOLOv8, Tesseract, OpenCV, PyTorch and
the OpenAI API, on a profile that said "ai intern", was searched for as web
development, full stack, frontend developer and python developer. Not one AI
query. The old expander was an if-ladder over seven skill buckets truncated at
four, and none of those five skills matched a bucket.
"""
import rolequeries


# The suite runs with the model half switched off (see conftest), so everything
# below exercises the deterministic ladder unless it stubs a provider itself.

def test_computer_vision_skills_produce_computer_vision_roles():
    roles = rolequeries.roles_for(
        ["python", "yolov8", "tesseract", "opencv", "pytorch"], ["ai intern"],
    )
    assert any("computer vision" in r for r in roles), roles
    assert any("machine learning" in r or "ai engineer" in r for r in roles), roles


def test_the_candidates_own_words_come_first():
    """They typed the domain themselves; nothing derived should outrank it."""
    roles = rolequeries.roles_for(["python", "react"], ["ai intern", "full stack"])
    assert roles[0].startswith("ai")


def test_a_web_stack_still_produces_web_roles():
    roles = rolequeries.roles_for(["react", "typescript", "node.js", "mongodb"], [])
    assert any("frontend" in r or "web developer" in r for r in roles)
    assert any("backend" in r or "software engineer" in r for r in roles)


def test_both_halves_of_a_split_stack_are_represented():
    """The failure mode was covering one capability and silently dropping the
    other, which is what a truncated list does to anyone who is not one thing."""
    roles = rolequeries.roles_for(
        ["react", "next.js", "pytorch", "opencv", "sql"], ["web development"],
    )
    joined = " ".join(roles)
    assert "frontend" in joined or "web developer" in joined
    assert "computer vision" in joined or "machine learning" in joined


def test_a_candidate_with_no_recognised_skill_still_gets_searched_for():
    roles = rolequeries.roles_for(["basket weaving"], [])
    assert roles
    assert all(isinstance(r, str) and r.strip() for r in roles)


def test_roles_are_titles_not_the_word_intern():
    """The search template adds "intern"; leaving it in the role produces
    "intern intern india"."""
    roles = rolequeries.roles_for(["python", "django"], ["machine learning internship"])
    assert not any(r.split() and r.split()[-1] == "intern" for r in roles), roles
    assert not any("internship" in r for r in roles), roles


def test_the_list_is_bounded_and_deduplicated():
    roles = rolequeries.roles_for(
        ["python", "react", "sql", "pytorch", "android", "docker", "figma", "java"],
        ["full stack", "full stack", "data"],
    )
    assert len(roles) <= rolequeries.MAX_ROLES
    assert len(roles) == len(set(roles))


def test_a_dead_model_degrades_to_the_ladder_not_to_nothing(monkeypatch):
    """Discovery must never fail because a provider is down."""
    monkeypatch.setenv("GRINDLY_ROLE_QUERIES_LLM", "1")
    monkeypatch.setattr(rolequeries, "_CACHE", {})
    monkeypatch.setattr(rolequeries, "_loaded", True)

    import llm

    def boom(*a, **k):
        raise RuntimeError("no provider answered")

    monkeypatch.setattr(llm, "chat_json", boom)
    roles = rolequeries.roles_for(["python", "opencv"], ["ai"])
    assert any("computer vision" in r or "machine learning" in r for r in roles)


def test_a_model_answer_is_merged_with_the_ladder(monkeypatch):
    """Neither alone was enough: the model reaches titles the ladder cannot, and
    the ladder covers stacks the model skims past."""
    monkeypatch.setenv("GRINDLY_ROLE_QUERIES_LLM", "1")
    monkeypatch.setattr(rolequeries, "_CACHE", {})
    monkeypatch.setattr(rolequeries, "_loaded", True)
    monkeypatch.setattr(rolequeries, "_save", lambda: None)

    import llm

    monkeypatch.setattr(
        llm, "chat_json",
        lambda *a, **k: {"roles": ["perception engineer", "robotics software engineer"]},
    )
    roles = rolequeries.roles_for(["python", "opencv"], ["ai"])
    assert "perception engineer" in roles          # only the model knows this one
    assert any("computer vision" in r for r in roles)  # ladder still contributes


def test_a_model_returning_junk_cannot_empty_the_list(monkeypatch):
    monkeypatch.setenv("GRINDLY_ROLE_QUERIES_LLM", "1")
    monkeypatch.setattr(rolequeries, "_CACHE", {})
    monkeypatch.setattr(rolequeries, "_loaded", True)
    monkeypatch.setattr(rolequeries, "_save", lambda: None)

    import llm

    for junk in (None, {}, {"roles": None}, {"roles": [1, 2]}, "not json"):
        monkeypatch.setattr(llm, "chat_json", lambda *a, **k: junk)
        assert rolequeries.roles_for(["python", "react"], ["web"])
