import os

import resume_parse


def test_find_resume_file_returns_none_when_dir_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(resume_parse, "RESUME_DIR", str(tmp_path / "does-not-exist"))
    assert resume_parse.find_resume_file("u1") is None


def test_find_resume_file_matches_by_uid_prefix(tmp_path, monkeypatch):
    monkeypatch.setattr(resume_parse, "RESUME_DIR", str(tmp_path))
    (tmp_path / "u1.pdf").write_bytes(b"%PDF-1.4 fake")
    (tmp_path / "u2.pdf").write_bytes(b"%PDF-1.4 other user")
    found = resume_parse.find_resume_file("u1")
    assert found == os.path.join(str(tmp_path), "u1.pdf")


def test_extract_text_reads_txt(tmp_path):
    f = tmp_path / "resume.txt"
    f.write_text("Skills: Python, React, SQL", encoding="utf-8")
    assert resume_parse.extract_text(str(f)) == "Skills: Python, React, SQL"


def test_extract_text_missing_file_returns_empty_not_raises(tmp_path):
    missing = str(tmp_path / "nope.txt")
    assert resume_parse.extract_text(missing) == ""


def test_extract_text_malformed_pdf_returns_empty_not_raises(tmp_path):
    # Not a real PDF — pdfminer should fail internally and _pdf_text should
    # swallow it, not propagate a crash up through the API route that calls
    # this during resume upload.
    f = tmp_path / "resume.pdf"
    f.write_bytes(b"this is not a real pdf, just garbage bytes" * 10)
    assert resume_parse.extract_text(str(f)) == ""


def test_extract_text_unsupported_extension_returns_empty(tmp_path):
    f = tmp_path / "resume.xyz"
    f.write_text("whatever", encoding="utf-8")
    assert resume_parse.extract_text(str(f)) == ""


def test_heuristic_skills_matches_known_terms():
    text = "Experienced in Python, React, and SQL. Familiar with Docker and AWS."
    skills = resume_parse._heuristic_skills(text)
    assert "python" in skills
    assert "react" in skills
    assert "sql" in skills
    assert "docker" in skills
    assert "aws" in skills


def test_heuristic_skills_respects_word_boundaries():
    # "java" must not match inside "javascript"
    text = "I only know javascript, not the other one."
    skills = resume_parse._heuristic_skills(text)
    assert "javascript" in skills
    assert "java" not in skills


def test_heuristic_skills_empty_text_returns_empty_list():
    assert resume_parse._heuristic_skills("") == []


def test_extract_skills_empty_text_short_circuits_without_llm_call(monkeypatch):
    called = {"hit": False}

    def fake_chat(*a, **kw):
        called["hit"] = True
        return []

    monkeypatch.setitem(
        __import__("sys").modules, "llm",
        type("M", (), {"chat_json_ensemble": staticmethod(fake_chat)}),
    )
    assert resume_parse.extract_skills("   ") == []
    assert called["hit"] is False


def test_extract_skills_uses_llm_result_when_valid(monkeypatch):
    def fake_chat(prompt, system, n=3):
        return ["Python", "React", "python"]  # dup + mixed case, should dedupe+lowercase

    monkeypatch.setitem(
        __import__("sys").modules, "llm",
        type("M", (), {"chat_json_ensemble": staticmethod(fake_chat)}),
    )
    skills = resume_parse.extract_skills("some resume text about python and react")
    assert skills == ["python", "react"]


def test_extract_skills_falls_back_to_heuristic_when_llm_returns_garbage(monkeypatch):
    def fake_chat(prompt, system, n=3):
        return "not a list"  # malformed LLM output

    monkeypatch.setitem(
        __import__("sys").modules, "llm",
        type("M", (), {"chat_json_ensemble": staticmethod(fake_chat)}),
    )
    skills = resume_parse.extract_skills("I know Python and Docker well.")
    assert "python" in skills
    assert "docker" in skills
