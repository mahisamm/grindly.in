"""The contract here is mostly about what must NOT happen: the user's template is
mandated by their college, so an edit that reflows the page or touches a section
outside Skills/Hobbies is worse than no edit at all."""
import os

import latex_resume
import resume_ai


TEX = r"""
\documentclass[a4paper,11pt]{article}
\usepackage[margin=0.6in]{geometry}
\begin{document}

\section{Education}
B.Tech CSE, Anurag University, CGPA 8.4

\section{Technical Skills}
Python, JavaScript, React, Node, SQL

\section{Projects}
\textbf{Grindly} --- an agent that applies to internships.

\section{Hobbies}
Chess, cricket, sketching

\end{document}
"""


# --- what the agent is allowed to see ---------------------------------------

def test_finds_only_the_editable_sections():
    ed = latex_resume.editable_sections(TEX)
    assert set(ed) == {"skills", "hobbies"}


def test_heading_variants_land_in_the_right_bucket():
    for heading in ("Skills", "TECHNICAL SKILLS", r"\textbf{Tech Stack}"):
        tex = "\\section{%s}\nfoo\n\\end{document}" % heading
        assert set(latex_resume.editable_sections(tex)) == {"skills"}


def test_the_body_span_excludes_the_heading_itself():
    """The \\section{...} heading is outside the editable span, so an edit can never
    rename a section, reorder it, or move it on the page."""
    sec = latex_resume.editable_sections(TEX)["skills"]
    body = sec.body(TEX)
    assert "Python" in body
    assert "\\section" not in body


def test_the_last_section_body_stops_at_end_document():
    """Otherwise the final editable section would swallow \\end{document} and an edit
    to it would produce a file that cannot compile at all."""
    sec = latex_resume.editable_sections(TEX)["hobbies"]
    assert "\\end{document}" not in sec.body(TEX)


# --- what a splice must preserve --------------------------------------------

def test_replace_preserves_every_other_byte():
    out = latex_resume.replace_bodies(TEX, {"skills": "\nRust, Go\n"})
    assert "Rust, Go" in out
    # untouched sections, preamble, and document terminator all survive verbatim
    for keep in (r"\usepackage[margin=0.6in]{geometry}", "CGPA 8.4",
                 r"\textbf{Grindly}", "Chess, cricket, sketching",
                 r"\end{document}"):
        assert keep in out
    assert "Python, JavaScript" not in out   # the old body is gone, not duplicated


def test_replacing_both_sections_at_once_does_not_corrupt_offsets():
    """Splices are applied back-to-front precisely so the first one can't shift the
    offsets of the second."""
    out = latex_resume.replace_bodies(
        TEX, {"skills": "\nRust\n", "hobbies": "\nRunning\n"}
    )
    assert "Rust" in out and "Running" in out
    assert "CGPA 8.4" in out and r"\textbf{Grindly}" in out
    assert out.count(r"\end{document}") == 1


def test_a_slot_the_document_does_not_have_is_ignored():
    tex = "\\section{Skills}\nPython\n\\end{document}"
    out = latex_resume.replace_bodies(tex, {"hobbies": "Chess"})
    assert out == tex


# --- security ---------------------------------------------------------------
# We compile a .tex the user uploaded, on our server. LaTeX can read files and,
# with shell-escape, execute commands.

def test_shell_escape_is_refused():
    assert latex_resume.unsafe_commands(r"\write18{rm -rf /}")


def test_absolute_path_reads_are_refused():
    assert latex_resume.unsafe_commands(r"\input{/etc/passwd}")


def test_a_clean_resume_is_not_flagged():
    assert latex_resume.unsafe_commands(TEX) == []


def test_compile_refuses_an_unsafe_document(tmp_path):
    out = str(tmp_path / "out.pdf")
    assert latex_resume.compile_pdf(r"\write18{id}" + TEX, out) is False


# --- neatness: an edit must not spill text past the margin --------------------
# The page-count check can't see an "Overfull \hbox" — the page total is
# unchanged but a line is running off the edge of the column. compile_report
# surfaces that count so the worker can reject an edit that isn't neat.

def _fake_tectonic(overfull_lines: int):
    """A subprocess.run stand-in: writes a resume.pdf and a resume.log (with the
    given number of overfull warnings) into whatever --outdir it's handed."""
    def run(cmd, **kw):
        outdir = cmd[cmd.index("--outdir") + 1]
        with open(os.path.join(outdir, "resume.pdf"), "wb") as f:
            f.write(b"%PDF-1.4\n%%EOF\n")
        log = "\n".join(r"Overfull \hbox (12.0pt too wide) in paragraph"
                        for _ in range(overfull_lines))
        with open(os.path.join(outdir, "resume.log"), "w", encoding="utf-8") as f:
            f.write("This is the log.\n" + log + "\nOutput written.\n")

        class _P:
            returncode = 0
            stdout = ""
            stderr = ""
        return _P()
    return run


def test_compile_report_counts_overfull_boxes(tmp_path, monkeypatch):
    monkeypatch.setattr(latex_resume, "tectonic_available", lambda: True)
    monkeypatch.setattr(latex_resume.subprocess, "run", _fake_tectonic(3))
    monkeypatch.setattr(latex_resume, "page_count", lambda p: 1)
    out = str(tmp_path / "out.pdf")

    r = latex_resume.compile_report(TEX, out)
    assert r.ok is True
    assert r.pages == 1
    assert r.overfull == 3          # the misalignment signal, read from the log
    assert os.path.exists(out)      # the built PDF was still delivered


def test_compile_report_clean_document_has_no_overfull(tmp_path, monkeypatch):
    monkeypatch.setattr(latex_resume, "tectonic_available", lambda: True)
    monkeypatch.setattr(latex_resume.subprocess, "run", _fake_tectonic(0))
    monkeypatch.setattr(latex_resume, "page_count", lambda p: 1)

    r = latex_resume.compile_report(TEX, str(tmp_path / "o.pdf"))
    assert r.ok is True and r.overfull == 0


def test_compile_report_refuses_unsafe_before_compiling(tmp_path):
    r = latex_resume.compile_report(r"\write18{id}" + TEX, str(tmp_path / "o.pdf"))
    assert r.ok is False


# --- the LLM's output is not trusted either ---------------------------------

def test_an_edit_that_escapes_its_section_is_rejected():
    old = "Python, React"
    for escape in (r"\section{Education} B.Tech from Harvard",
                   r"\end{document}",
                   r"\usepackage{tikz}"):
        assert resume_ai._latex_body_is_safe(escape, old) is False


def test_an_edit_with_unbalanced_braces_is_rejected():
    assert resume_ai._latex_body_is_safe(r"\textbf{Python", "Python") is False


def test_an_edit_that_balloons_is_rejected():
    """A section body that grew 5x has reflowed the page whatever it claims."""
    assert resume_ai._latex_body_is_safe("Python, " * 200, "Python, React") is False


def test_reordering_and_dropping_skills_is_allowed():
    old = "Python, JavaScript, React, Node, SQL"
    new = "React, JavaScript, Node"          # reordered + dropped, nothing invented
    assert resume_ai._latex_body_is_safe(new, old) is True
    assert resume_ai._no_invented_skills(new, old, ["python", "react"]) is True


def test_inventing_a_skill_is_rejected():
    """The truthfulness guard. A fabricated skill is a wasted interview — the
    candidate cannot defend it in the room."""
    old = "Python, JavaScript"
    new = "Python, JavaScript, Kubernetes"   # never on the resume, never in master
    assert resume_ai._no_invented_skills(new, old, ["python", "javascript"]) is False


def test_a_master_skill_absent_from_the_section_may_be_surfaced():
    """Promoting a skill the candidate really has — it's in their master set, just
    not currently listed in that section — is the whole point of tailoring."""
    old = "Python, JavaScript"
    new = "Python, JavaScript, Docker"
    assert resume_ai._no_invented_skills(new, old, ["python", "javascript", "docker"]) is True


# --- fit: when do we bother editing at all? ---------------------------------

RESUME_TEXT = "Skills: python, react, node, sql, docker. Built a full stack app."


def test_a_resume_that_already_covers_the_role_is_left_alone():
    job = {"title": "Full Stack Intern", "skills": ["react", "node"]}
    assert resume_ai.fit_score(RESUME_TEXT, job) >= resume_ai.TAILOR_THRESHOLD


def test_a_resume_missing_the_role_requirements_scores_low():
    job = {"title": "ML Intern", "skills": ["pytorch", "tensorflow", "nlp"]}
    assert resume_ai.fit_score(RESUME_TEXT, job) < resume_ai.TAILOR_THRESHOLD


def test_a_role_with_no_readable_requirements_is_not_tailored_toward():
    """No requirements means "we couldn't read what this role wants", not "the
    candidate meets none of them". There is nothing to tailor toward, so the master
    resume goes out untouched rather than being edited against a guess."""
    assert resume_ai.fit_score(RESUME_TEXT, {"title": "Intern", "skills": []}) == 100


def test_an_empty_resume_scores_zero():
    assert resume_ai.fit_score("", {"title": "X", "skills": ["react"]}) == 0


# --- the upload-time self-test ----------------------------------------------
# Everything below would otherwise fail SILENTLY and permanently: compile_pdf()
# returns False, the master resume goes out untouched on every application, and
# the user is never told the file they uploaded is doing nothing.

import worker  # noqa: E402


def _check(monkeypatch, tex, **over):
    monkeypatch.setattr(worker.latex_resume, "read_tex", lambda uid: tex)
    monkeypatch.setattr(worker.latex_resume, "tectonic_available",
                        lambda: over.get("tectonic", True))
    monkeypatch.setattr(worker.latex_resume, "compile_pdf",
                        lambda src, out: over.get("compiles", True))
    monkeypatch.setattr(worker.latex_resume, "page_count",
                        lambda p: over.get("pages", 1))
    monkeypatch.setattr(worker.resume_parse, "find_resume_file",
                        lambda uid: over.get("master"))
    saved: dict = {}
    monkeypatch.setattr(worker.db, "set_tex_status",
                        lambda uid, status, detail="": saved.update(
                            status=status, detail=detail))
    result = worker.latex_check("u1")
    return result, saved


def test_a_good_tex_is_marked_ok_and_names_what_may_be_edited(monkeypatch):
    result, saved = _check(monkeypatch, TEX)
    assert result["status"] == "ok"
    assert saved["status"] == "ok"
    assert result["sections"] == ["hobbies", "skills"]


def test_a_tex_with_no_editable_section_is_reported_not_silently_ignored(monkeypatch):
    """The likeliest real failure: a college template whose headings use macros we
    don't recognise. The agent can't tailor it — the user must be told, not left to
    assume it's working."""
    _, saved = _check(monkeypatch, r"\section{Education}\nB.Tech\n\end{document}")
    assert saved["status"] == "no_sections"
    assert "Skills" in saved["detail"]


def test_a_tex_that_will_not_compile_is_reported(monkeypatch):
    _, saved = _check(monkeypatch, TEX, compiles=False)
    assert saved["status"] == "compile_failed"


def test_a_missing_compiler_is_reported_rather_than_blamed_on_the_user(monkeypatch):
    _, saved = _check(monkeypatch, TEX, tectonic=False)
    assert saved["status"] == "no_compiler"


def test_a_tex_that_is_not_the_same_document_as_the_pdf_is_rejected(monkeypatch):
    """If the untouched .tex already compiles to a different page count than the
    master PDF, they aren't the same document — and no edit to it can be trusted to
    preserve a layout it never produced."""
    pages = iter([2, 1])   # tex -> 2 pages, master PDF -> 1 page
    monkeypatch.setattr(worker.latex_resume, "read_tex", lambda uid: TEX)
    monkeypatch.setattr(worker.latex_resume, "tectonic_available", lambda: True)
    monkeypatch.setattr(worker.latex_resume, "compile_pdf", lambda s, o: True)
    monkeypatch.setattr(worker.latex_resume, "page_count", lambda p: next(pages))
    monkeypatch.setattr(worker.resume_parse, "find_resume_file", lambda uid: "master.pdf")
    saved: dict = {}
    monkeypatch.setattr(worker.db, "set_tex_status",
                        lambda uid, status, detail="": saved.update(status=status))
    worker.latex_check("u1")
    assert saved["status"] == "page_mismatch"


def test_an_unsafe_tex_is_refused_before_it_ever_reaches_the_compiler(monkeypatch):
    _, saved = _check(monkeypatch, r"\write18{id}" + TEX)
    assert saved["status"] == "unsafe"
