"""Read a pasted job description into the handful of things we can act on.

The user pastes a JD; we need the skills the role actually asks for so the
coverage band in `readiness` has something to measure against, and so the gap
panel can ask about what is missing.

Two extractors, deliberately in this order:

  1. A deterministic pass over a curated vocabulary. Always runs, needs no key,
     never varies. This is what makes the coverage number reproducible: paste
     the same JD twice and get the same required-skills list twice.
  2. An LLM pass that may ADD skills the vocabulary does not know (a niche
     framework, a domain term, an in-house tool). Additive only, and every
     addition must appear verbatim in the JD text — a model that "infers" that
     a backend role needs Docker when the posting never says so would put a
     phantom gap in front of the user and, worse, invite them to claim it.

The split matters because the two failure modes are opposite. A vocabulary-only
extractor silently misses whatever it has not heard of. A model-only extractor
invents plausible requirements. Running the deterministic pass first and letting
the model only append verified-present terms gets the recall without the
invention, and degrades to "slightly fewer skills" rather than "wrong skills"
when no provider answers.

Nothing here scrapes. A job description arrives because a human copied it out of
a posting they were already looking at and pasted it into a textarea.
"""
from __future__ import annotations

import re

# The vocabulary the deterministic pass knows. Sourced from what actually
# appears in Indian campus and early-career postings — deliberately broader than
# software, because a resume product that only understands engineering roles is
# useless to the commerce and design students in the same placement cell.
VOCAB: tuple[str, ...] = (
    # languages
    "python", "java", "javascript", "typescript", "c", "c++", "c#", "go", "rust",
    "kotlin", "swift", "php", "ruby", "scala", "r", "matlab", "sql", "dart",
    "verilog", "systemverilog", "vhdl", "assembly", "bash", "powershell",
    # web / mobile
    "react", "next.js", "angular", "vue", "svelte", "node", "express", "django",
    "flask", "fastapi", "spring", "spring boot", ".net", "asp.net", "laravel",
    "rails", "html", "css", "tailwind", "bootstrap", "sass", "jquery", "redux",
    "react native", "flutter", "android", "ios", "swiftui", "jetpack compose",
    # data / ml
    "pandas", "numpy", "scipy", "scikit-learn", "pytorch", "tensorflow", "keras",
    "machine learning", "deep learning", "nlp", "computer vision", "opencv",
    "data analysis", "data science", "statistics", "power bi", "tableau", "excel",
    "spark", "hadoop", "airflow", "dbt", "etl", "data warehouse", "llm",
    "snowflake", "databricks", "bigquery", "redshift", "looker", "superset",
    "langchain", "hugging face", "transformers", "xgboost", "mlflow",
    # Vector stores and retrieval. Added because an adversarial rewrite put
    # "Tuned pinecone and weaviate retrieval" into a resume that had never
    # mentioned either: lowercase, so the capitalisation tell missed it, and
    # absent from the vocabulary, so the vocabulary tell missed it too.
    "pinecone", "weaviate", "milvus", "qdrant", "chroma", "faiss", "pgvector",
    "rag", "embeddings", "vector database", "opensearch", "solr",
    "celery", "rabbitmq", "nats", "temporal", "dagster", "prefect",
    "grpc", "protobuf", "openapi", "swagger", "websocket", "webrtc",
    "vite", "webpack", "babel", "eslint", "storybook", "playwright", "puppeteer",
    "sentry", "datadog", "prometheus", "loki", "opentelemetry",
    "keycloak", "auth0", "oauth", "saml", "jwt", "ecs", "eks", "iam", "sqs",
    "sns", "lambda", "cloudfront", "route53", "cloudformation", "pulumi",
    # infra
    "aws", "azure", "gcp", "google cloud", "docker", "kubernetes", "terraform",
    "ansible", "jenkins", "ci/cd", "git", "github actions", "linux", "unix",
    "nginx", "kafka", "rabbitmq", "redis", "elasticsearch", "grafana",
    # databases
    "postgresql", "mysql", "mongodb", "sqlite", "oracle", "dynamodb", "cassandra",
    "firebase", "supabase",
    # cs fundamentals — named explicitly in campus postings
    "data structures", "algorithms", "operating systems", "dbms", "computer networks",
    "oops", "object-oriented programming", "system design", "distributed systems",
    "microservices", "rest api", "graphql", "grpc", "multithreading",
    # embedded / hardware
    "embedded", "firmware", "rtos", "microcontroller", "arduino", "raspberry pi",
    "device drivers", "dsp", "signal processing", "computer architecture", "fpga",
    "pcb", "cad", "solidworks", "ansys", "autocad", "catia",
    # qa / security
    "selenium", "cypress", "jest", "pytest", "junit", "manual testing",
    "automation testing", "penetration testing", "cybersecurity", "cryptography",
    # design
    "figma", "adobe xd", "photoshop", "illustrator", "ui/ux", "wireframing",
    "prototyping", "user research",
    # business / ops
    "agile", "scrum", "jira", "product management", "business analysis",
    "market research", "seo", "sem", "content writing", "copywriting",
    "social media marketing", "google analytics", "salesforce", "sap",
    "financial modelling", "accounting", "tally", "supply chain", "six sigma",
    "stakeholder management", "communication", "presentation",
)

# Sorted longest-first so "machine learning" is claimed before "learning" and
# "spring boot" before "spring". Without this the shorter term wins and the
# longer, more specific requirement disappears from the gap report.
_VOCAB_SORTED = tuple(sorted(VOCAB, key=len, reverse=True))

# Sections of a JD that describe the ROLE rather than the candidate. Skills
# named only in these are usually the team's stack, not a requirement, but we
# keep them as nice-to-have rather than dropping them.
_MUST_MARKERS = re.compile(
    r"\b(required|requirements?|must[\s-]?have|essential|mandatory|minimum "
    r"qualifications?|you (?:will )?need|we require|eligibility)\b", re.I,
)
_NICE_MARKERS = re.compile(
    r"\b(preferred|nice[\s-]?to[\s-]?have|good to have|bonus|plus|desirable|"
    r"advantage|optional|added advantage)\b", re.I,
)

_TITLE_RE = re.compile(
    r"^\s*(?:job\s*title|position|role|designation)\s*[:\-]\s*(.+)$", re.I | re.M,
)
_COMPANY_RE = re.compile(
    r"^\s*(?:company|organisation|organization|employer)\s*[:\-]\s*(.+)$", re.I | re.M,
)

MAX_JD_CHARS = 20000
MAX_SKILLS = 30


def _present(text_low: str, term: str) -> bool:
    """Whole-token containment, tolerant of the punctuation skill names carry."""
    return re.search(r"(?<![a-z0-9])" + re.escape(term) + r"(?![a-z0-9])", text_low) is not None


def _split_sections(text: str) -> tuple[str, str]:
    """(must_have_region, nice_to_have_region).

    A JD is prose, not a schema, so this is a heuristic and it says so: the
    region after a "preferred/bonus" marker is treated as nice-to-have until the
    next "required" marker. When neither marker appears — which is most short
    postings — everything is must-have, because assuming a requirement is
    optional is the error that costs the user an application.
    """
    must_parts: list[str] = []
    nice_parts: list[str] = []
    current = must_parts
    for line in text.splitlines():
        if _NICE_MARKERS.search(line):
            current = nice_parts
        elif _MUST_MARKERS.search(line):
            current = must_parts
        current.append(line)
    return "\n".join(must_parts), "\n".join(nice_parts)


def _vocab_skills(text: str) -> list[str]:
    low = text.lower()
    found: list[str] = []
    for term in _VOCAB_SORTED:
        if _present(low, term) and term not in found:
            found.append(term)
    return found


def parse(jd_text: str, use_llm: bool = True) -> dict:
    """Parse a pasted job description.

    Returns::

        {"title": str, "company": str,
         "must_have": [str], "nice_to_have": [str],
         "skills": [str],           # must + nice, deduped — what coverage scores on
         "source_chars": int, "llm_added": [str]}

    Never raises and never returns None. An unparseable blob of text yields
    empty lists, which the caller renders as "we could not read any specific
    requirements out of this" — an honest outcome, and better than guessing.
    """
    text = (jd_text or "")[:MAX_JD_CHARS]
    stripped = text.strip()
    if not stripped:
        return {"title": "", "company": "", "must_have": [], "nice_to_have": [],
                "skills": [], "source_chars": 0, "llm_added": []}

    title_m = _TITLE_RE.search(text)
    company_m = _COMPANY_RE.search(text)

    must_region, nice_region = _split_sections(text)
    must = _vocab_skills(must_region)
    nice = [s for s in _vocab_skills(nice_region) if s not in must]

    llm_added: list[str] = []
    if use_llm:
        for extra in _llm_extra_skills(stripped, known=set(must) | set(nice)):
            # The verbatim check is the guarantee, not the prompt. A model told
            # "only skills stated in the text" still occasionally returns a
            # neighbouring technology, and a phantom requirement is worse than a
            # missed one: it tells the user they have a gap they do not have.
            if _present(stripped.lower(), extra.lower()):
                must.append(extra)
                llm_added.append(extra)

    skills = (must + [n for n in nice if n not in must])[:MAX_SKILLS]
    return {
        "title": (title_m.group(1).strip()[:120] if title_m else ""),
        "company": (company_m.group(1).strip()[:120] if company_m else ""),
        "must_have": must[:MAX_SKILLS],
        "nice_to_have": nice[:MAX_SKILLS],
        "skills": skills,
        "source_chars": len(stripped),
        "llm_added": llm_added,
    }


_EXTRA_SYS = (
    "You extract the concrete technical skills, tools and technologies a job "
    "description explicitly requires. "
    "Return ONLY a JSON array of short lowercase strings, at most 12. "
    "Every string you return MUST appear verbatim in the job description text. "
    "Do NOT infer related technologies. Do NOT return soft skills, seniority "
    "words, degrees, or company names. If nothing qualifies, return []."
)


def _llm_extra_skills(jd_text: str, known: set[str]) -> list[str]:
    """Skills the vocabulary missed. Additive, verbatim-checked by the caller."""
    try:
        import llm as llm_mod
    except Exception:  # noqa: BLE001
        return []
    known_line = ", ".join(sorted(known)) if known else "(none)"
    prompt = (
        f"Job description:\n\"\"\"\n{jd_text[:5000]}\n\"\"\"\n\n"
        f"Already extracted, do not repeat: {known_line}\n\n"
        "Return the JSON array of any ADDITIONAL required skills stated in the text."
    )
    try:
        out = llm_mod.chat_json_ensemble(
            prompt, system=_EXTRA_SYS, n=2, timeout=45, temperature=0.0)
    except Exception:  # noqa: BLE001
        return []
    if not isinstance(out, list):
        return []
    cleaned: list[str] = []
    for item in out[:12]:
        s = str(item).strip().lower()
        if s and 1 < len(s) < 40 and s not in known and s not in cleaned:
            cleaned.append(s)
    return cleaned
