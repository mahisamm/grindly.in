"""Extract resume text (pdf/docx/txt) and pull a skill list from it via the
local LLM, with a keyword fallback when the model is unavailable."""
from __future__ import annotations
import os
import re

RESUME_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "resumes")

# Common tech/role skills used for the heuristic fallback + to seed the LLM.
KNOWN_SKILLS = [
    "python", "javascript", "typescript", "java", "c++", "c", "go", "rust", "sql",
    "react", "next.js", "node", "express", "django", "flask", "fastapi", "spring",
    "html", "css", "tailwind", "redux", "vue", "angular", "svelte",
    "pandas", "numpy", "pytorch", "tensorflow", "scikit-learn", "machine learning",
    "deep learning", "nlp", "computer vision", "data analysis", "data science",
    "aws", "gcp", "azure", "docker", "kubernetes", "git", "linux", "mongodb",
    "postgresql", "mysql", "redis", "graphql", "rest api", "figma", "ui/ux",
    "marketing", "seo", "content writing", "excel", "power bi", "tableau",
    "android", "kotlin", "swift", "flutter", "react native", "firebase",
]


def find_resume_file(uid: str) -> str | None:
    if not os.path.isdir(RESUME_DIR):
        return None
    for f in os.listdir(RESUME_DIR):
        if f.startswith(uid + "."):
            return os.path.join(RESUME_DIR, f)
    return None


def extract_text(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".txt":
            return open(path, encoding="utf-8", errors="ignore").read()
        if ext == ".pdf":
            return _pdf_text(path)
        if ext in (".docx", ".doc"):
            return _docx_text(path)
    except Exception as e:  # noqa: BLE001
        print(f"[resume] extract failed for {path}: {e}")
    return ""


def _pdf_text(path: str) -> str:
    try:
        from pdfminer.high_level import extract_text as pdf_extract
        return pdf_extract(path) or ""
    except Exception as e:  # noqa: BLE001
        print(f"[resume] pdfminer unavailable ({e}); install pdfminer.six")
        return ""


def _docx_text(path: str) -> str:
    try:
        import docx  # python-docx
        d = docx.Document(path)
        return "\n".join(p.text for p in d.paragraphs)
    except Exception as e:  # noqa: BLE001
        print(f"[resume] python-docx unavailable ({e})")
        return ""


def extract_skills(resume_text: str) -> list[str]:
    """LLM-first skill extraction, heuristic fallback."""
    text = (resume_text or "").strip()
    if not text:
        return []

    from llm import chat_json

    system = (
        "You extract a candidate's concrete, hireable skills from their resume. "
        "Return ONLY a JSON array of short skill strings (max 20), lowercase, "
        "no soft skills, no sentences."
    )
    prompt = f"Resume:\n\"\"\"\n{text[:6000]}\n\"\"\"\n\nReturn the JSON array of skills."
    out = chat_json(prompt, system)
    if isinstance(out, list) and out:
        skills = []
        for s in out:
            s = str(s).strip().lower()
            if s and len(s) < 40 and s not in skills:
                skills.append(s)
        if skills:
            return skills[:20]

    return _heuristic_skills(text)


def _heuristic_skills(text: str) -> list[str]:
    low = text.lower()
    found = []
    for sk in KNOWN_SKILLS:
        # word-ish boundary match
        if re.search(r"(?<![a-z])" + re.escape(sk) + r"(?![a-z])", low):
            found.append(sk)
    return found[:20]
