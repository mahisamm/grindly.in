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
    """PDF text, pdfminer first with a pypdf second opinion.

    Two extractors because one is not enough in practice: pdfminer returned
    almost nothing for Tectonic-compiled resume variants (see resume_optimize),
    which made a working optimizer look like it "couldn't beat your resume" to
    the user. They fail on different things, so we take whichever reads more.
    """
    pdfminer_text = ""
    try:
        from pdfminer.high_level import extract_text as pdf_extract
        pdfminer_text = pdf_extract(path) or ""
    except Exception as e:  # noqa: BLE001
        print(f"[resume] pdfminer failed ({e}); trying pypdf")

    if len(pdfminer_text.strip()) >= 200:
        return pdfminer_text

    try:
        import pypdf
        reader = pypdf.PdfReader(path)
        alt = "\n".join((p.extract_text() or "") for p in reader.pages)
    except Exception as e:  # noqa: BLE001
        print(f"[resume] pypdf fallback unavailable ({e})")
        return pdfminer_text

    if len(alt.strip()) > len(pdfminer_text.strip()):
        print(f"[resume] pypdf read {len(alt.strip())} chars where pdfminer read "
              f"{len(pdfminer_text.strip())} — using pypdf")
        return alt
    return pdfminer_text


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

    from llm import chat_json_ensemble

    system = (
        "You extract a candidate's concrete, hireable technical skills from their resume. "
        "Return ONLY a JSON array of short skill strings (max 25), lowercase, "
        "no soft skills, no buzzwords, no sentences. "
        "Examples: [\"python\", \"react\", \"sql\", \"docker\", \"machine learning\"]"
    )
    prompt = f"Resume:\n\"\"\"\n{text[:6000]}\n\"\"\"\n\nReturn the JSON array of skills only."
    out = chat_json_ensemble(prompt, system, n=3)
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
