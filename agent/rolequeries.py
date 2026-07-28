"""Turn a candidate into the job titles employers actually post.

Discovery searched for whatever `worker._expand_search_keywords` produced, and
that was an if-ladder over seven hardcoded skill buckets, capped at four query
sets. Measured on a real resume full of YOLOv8, Tesseract, OpenCV, Three.js and
the OpenAI API, it emitted: web development, full stack, frontend developer,
python developer. Every AI and computer-vision angle — half of what the person
can actually do, and the domain they typed into their own profile — was never
searched once. Nothing reported this; the run looked healthy and returned
results, just not theirs.

The gap is that a skill is not a job title. Nobody posts a "YOLOv8 internship";
they post "Computer Vision Intern", "AI/ML Engineer Intern", "Perception Intern".
Bridging the two is a language problem, so it is asked of a language model, with
two safeguards that matter more than the model does:

  * a deterministic fallback covering the common Indian student stacks, so a
    dead provider degrades to the old behaviour instead of to nothing, and
  * a cache keyed by the candidate's own skills+domains, because this answer
    changes when the resume changes and not once per sweep.

Everything returned is a ROLE TITLE, never a skill and never a company.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import time

MAX_ROLES = int(os.environ.get("GRINDLY_ROLE_QUERIES_MAX", "12"))

# Kill switch for the model half. The deterministic ladder below is a complete
# implementation on its own, so turning this off degrades coverage rather than
# breaking discovery — which is what makes it safe for the test suite to set,
# and what makes it the right lever if a provider starts costing more than it
# returns.
def _llm_enabled() -> bool:
    return (os.environ.get("GRINDLY_ROLE_QUERIES_LLM") or "1").strip() not in ("0", "false", "no")

_SYS = (
    "You map a candidate's skills onto the job titles employers actually "
    "advertise for internships in India. You answer only with JSON."
)

_PROMPT = """Given these skills and interest areas, list the internship job TITLES an
employer in India would advertise that this candidate could apply to.

Skills: {skills}
Interest areas: {domains}

Rules:
- Job titles only, as they appear on a careers page. Not skills, not companies.
- Drop the word "intern"/"internship" itself — it is added by the search.
- Between 8 and {n} titles, most-relevant first.
- Cover EVERY distinct capability in the list. If the candidate has both web and
  machine-learning skills, both must be represented.
- Use the words employers use: "Machine Learning Engineer", not "AI person";
  "Full Stack Developer", not "MERN".
- Lowercase, no punctuation.

Return JSON only: {{"roles": ["software engineer", "machine learning engineer", ...]}}"""


# Skill -> role titles, for when no model answers. Ordered so the most specific
# capability wins the front of the list; a candidate with computer vision skills
# should be searched for as a vision engineer before "software engineer".
_FALLBACK: list[tuple[tuple[str, ...], tuple[str, ...]]] = [
    (("computer vision", "opencv", "yolo", "yolov8", "tesseract", "ocr", "image"),
     ("computer vision engineer", "ai engineer")),
    (("machine learning", "deep learning", "pytorch", "tensorflow", "sklearn",
      "scikit", "keras", "ml"),
     ("machine learning engineer", "data scientist", "ai engineer")),
    (("llm", "openai", "langchain", "generative", "genai", "rag", "nlp",
      "transformers", "hugging face"),
     ("ai engineer", "generative ai engineer", "nlp engineer")),
    (("pandas", "numpy", "sql", "postgresql", "mysql", "excel", "tableau",
      "power bi", "data analysis"),
     ("data analyst", "data engineer")),
    (("react", "next.js", "nextjs", "vue", "angular", "javascript", "typescript",
      "tailwind", "html", "css"),
     ("frontend developer", "web developer", "ui developer")),
    (("node", "node.js", "express", "nestjs", "fastapi", "django", "flask",
      "spring", "springboot", "mongodb", "redis"),
     ("backend developer", "software engineer")),
    (("kotlin", "android", "flutter", "dart", "swift", "ios", "react native"),
     ("mobile app developer", "android developer")),
    (("docker", "kubernetes", "aws", "azure", "gcp", "terraform", "ci/cd",
      "jenkins", "linux"),
     ("devops engineer", "cloud engineer", "site reliability engineer")),
    (("three.js", "threejs", "webgl", "unity", "blender", "3d", "ar", "vr"),
     ("graphics engineer", "game developer")),
    (("playwright", "selenium", "cypress", "pytest", "junit", "testing", "qa"),
     ("qa engineer", "software test engineer")),
    (("figma", "ux", "ui design", "adobe", "photoshop", "illustrator"),
     ("ui ux designer", "product designer")),
    (("java", "c++", "c#", "golang", "go", "rust", "python"),
     ("software engineer", "software developer")),
]


def triggered_clusters(skills: list[str], domains: list[str]) -> list[tuple[str, ...]]:
    """The distinct kinds of role this candidate's skills qualify them for."""
    blob = " ".join(str(s).lower() for s in list(skills) + list(domains))
    return [roles for triggers, roles in _FALLBACK if any(t in blob for t in triggers)]


def _every_capability_represented(
    merged: list[str], skills: list[str], domains: list[str],
) -> list[str]:
    """Guarantee one role per capability the candidate actually has.

    Truncating a merged list to a cap drops whichever capabilities happened to
    sort last — measured, that silently lost data, devops and graphics for a
    candidate holding SQL, Docker and Three.js, because the model's twelve
    answers filled the cap before the ladder's clusters were reached. Coverage
    has to be a property of the list, not a coincidence of its ordering.
    """
    clusters = triggered_clusters(skills, domains)
    if not clusters:
        return merged
    head = merged[:max(0, MAX_ROLES - len(clusters))]
    covered = " ".join(head)
    missing = [names[0] for names in clusters
               if not any(n[:6] in covered for n in names)]
    tail = [r for r in merged if r not in head and r not in missing]
    out: list[str] = []
    for r in head + missing + tail:
        if r not in out:
            out.append(r)
    return out


def _norm(role: str) -> str:
    role = re.sub(r"[^a-z0-9+/. ]+", " ", (role or "").lower())
    # "machine learning engineer intern" and "intern - data analyst" are the same
    # query once the search template adds the word back.
    role = re.sub(r"\b(intern|interns|internship|internships|trainee)\b", " ", role)
    return re.sub(r"\s+", " ", role).strip()


def fallback_roles(skills: list[str], domains: list[str]) -> list[str]:
    """Role titles without a model. Deterministic, and never empty."""
    blob = " ".join(str(s).lower() for s in list(skills) + list(domains))
    out: list[str] = []
    for triggers, roles in _FALLBACK:
        if any(t in blob for t in triggers):
            out.extend(roles)
    # The candidate's own words come first — they typed them, they know.
    seeded = [_norm(d) for d in domains if _norm(d)]
    ordered = seeded + [r for r in out if r not in seeded]
    if not ordered:
        ordered = ["software engineer", "software developer"]
    seen: set[str] = set()
    final = []
    for r in ordered:
        if r and r not in seen:
            seen.add(r)
            final.append(r)
    return final[:MAX_ROLES]


# ---- cache ------------------------------------------------------------------
#
# Keyed by the candidate's skills+domains, not by user: two people with the same
# stack get the same answer, and one person's answer only changes when their
# resume does. On the shared data volume so it survives the deploy restart that
# would otherwise re-ask the model for every user on the next sweep.

_CACHE_FILE = os.path.join(
    os.environ.get("GRINDLY_DATA_DIR")
    or os.path.join(os.path.dirname(__file__), "..", "data"),
    "role_queries.json",
)
CACHE_TTL = int(os.environ.get("GRINDLY_ROLE_QUERIES_TTL", "2592000"))  # 30d
_CACHE: dict[str, tuple[float, list[str]]] = {}
_loaded = False


# Bump when the shape of the answer changes, not when the wording does.
#
# The cluster-coverage guarantee shipped and changed nothing in production for
# thirty days, because every user's roles were already cached from before it
# existed — the fix was live, correct, and completely invisible. A cache keyed
# only on the INPUT cannot notice that the function computing the output moved.
LOGIC_VERSION = "2"


def _key(skills: list[str], domains: list[str]) -> str:
    blob = "|".join(sorted(str(s).lower().strip() for s in skills))
    blob += "//" + "|".join(sorted(str(d).lower().strip() for d in domains))
    blob += "//v" + LOGIC_VERSION
    return hashlib.sha1(blob.encode()).hexdigest()[:20]


def _load() -> None:
    global _loaded
    if _loaded:
        return
    _loaded = True  # first: a corrupt file must not be reread per call
    try:
        with open(_CACHE_FILE, encoding="utf-8") as f:
            raw = json.load(f)
        now = time.time()
        for k, (ts, roles) in (raw or {}).items():
            if now - ts <= CACHE_TTL and roles:
                _CACHE[k] = (ts, roles)
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print(f"[rolequeries] cache load skipped: {type(e).__name__}")


def _save() -> None:
    try:
        os.makedirs(os.path.dirname(_CACHE_FILE), exist_ok=True)
        tmp = _CACHE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({k: [ts, r] for k, (ts, r) in _CACHE.items()}, f)
        os.replace(tmp, _CACHE_FILE)
    except Exception as e:  # noqa: BLE001
        print(f"[rolequeries] cache save skipped: {type(e).__name__}")


def roles_for(skills: list[str], domains: list[str], use_llm: bool = True) -> list[str]:
    """Role titles to search for. Never empty, never raises."""
    skills = [str(s) for s in (skills or []) if str(s).strip()]
    domains = [str(d) for d in (domains or []) if str(d).strip()]
    base = fallback_roles(skills, domains)
    if not use_llm or not _llm_enabled() or not skills:
        return base

    key = _key(skills, domains)
    _load()
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] <= CACHE_TTL:
        return hit[1]

    roles: list[str] = []
    try:
        import llm

        data = llm.chat_json(
            _PROMPT.format(
                skills=", ".join(skills[:24]),
                domains=", ".join(domains[:6]) or "not stated",
                n=MAX_ROLES,
            ),
            system=_SYS,
            timeout=60,
        )
        if isinstance(data, dict):
            roles = [_norm(r) for r in (data.get("roles") or []) if isinstance(r, str)]
    except Exception as e:  # noqa: BLE001 — discovery must never fail on this
        print(f"[rolequeries] model unavailable ({type(e).__name__}); using fallback")

    # Union, model first: the model reaches titles the ladder cannot, and the
    # ladder covers stacks the model may skim past. Neither alone was enough.
    merged: list[str] = []
    seen: set[str] = set()
    for r in roles + base:
        r = _norm(r)
        if r and r not in seen and len(r) > 2:
            seen.add(r)
            merged.append(r)
    merged = _every_capability_represented(merged, skills, domains)[:MAX_ROLES]

    if roles:  # only cache a real model answer; the fallback is free to recompute
        _CACHE[key] = (time.time(), merged)
        _save()
    print(f"[rolequeries] {len(merged)} role title(s): {', '.join(merged)}")
    return merged
