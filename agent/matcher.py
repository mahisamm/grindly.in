"""Score a listing against the candidate's skills, and apply the firewall
constraints from their profile. Deterministic + free; the score IS the
threshold the user set in onboarding (min_match_score)."""
from __future__ import annotations
import json
import re

# The vocabulary we are willing to name as a gap to the user. Reuses the resume
# parser's list so we never tell someone they're "missing" a word that isn't
# actually a real, learnable skill.
try:
    from resume_parse import KNOWN_SKILLS as _KNOWN_FOR_GAP
except Exception:  # noqa: BLE001 — matcher is importable standalone in tests
    _KNOWN_FOR_GAP: list[str] = []


# How much of a job description the semantic pass may read. Matches the window
# score_job uses for keyword matching, and it is the whole point: at 1200 the
# comparison saw a posting's masthead, cookie notice and "about us" — the very
# boilerplate the keyword window was widened to 6000 to get past — while the
# requirements section naming the stack sat below the cut. The semantic signal
# was therefore computed against the least informative part of every page.
_JD_WINDOW = 6000


def _tfidf_score(text_a: str, text_b: str) -> float:
    """TF-IDF cosine similarity between two text blobs. 0.0-1.0.

    Fit on these two documents alone, so the IDF term carries little
    information — with a corpus of two, a word is in half the corpus or all of
    it. What survives is a length-normalised weighted overlap, which is a
    reasonable similarity and is used accordingly: a small ADDITIVE bonus in
    score_job, never a multiplier on the score. Returns 0.0 rather than raising
    if scikit-learn is unavailable, so scoring degrades to keywords instead of
    failing a run.
    """
    if not text_a or not text_b:
        return 0.0
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.metrics.pairwise import cosine_similarity as _cos
        vect = TfidfVectorizer(stop_words="english", max_features=2000)
        mat = vect.fit_transform([text_a[:_JD_WINDOW], text_b[:_JD_WINDOW]])
        return float(_cos(mat[0:1], mat[1:2])[0][0])
    except Exception:  # noqa: BLE001
        return 0.0


# normalize skill spellings so equivalents match (node.js == nodejs == node)
_ALIAS = {
    "node.js": "node", "nodejs": "node", "node js": "node",
    "next.js": "nextjs", "reactjs": "react", "react.js": "react",
    "react native": "reactnative", "rest api": "restapi",
    "scikit-learn": "sklearn", "ui/ux": "uiux", "power bi": "powerbi",
    # "React JS Development Internship" is one of the commonest listing titles
    # on Internshala, and its "js" token matched nothing at all — a candidate
    # whose resume says "javascript" scored no hit on a JavaScript job.
    "js": "javascript", "ts": "typescript", "ml": "machine learning",
}


def _alias(s: str) -> str:
    s = s.strip().lower()
    return _ALIAS.get(s, s)


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9+./ ]", " ", (s or "").lower())


def _tokens(s: str) -> set[str]:
    """Aliased token set. The alias map has to apply to listing text too, not just
    to the candidate's declared skills — otherwise "React JS" in a title never
    lines up with "javascript" on a resume."""
    out: set[str] = set()
    for t in _norm(s).split():
        if len(t) <= 1:
            continue
        out.update(_ALIAS.get(t, t).split())
    return out


# How many of the candidate's own skills a listing must mention before the
# "this listing is in my field" signal is saturated. It is a COUNT, not a ratio
# over the candidate's whole skill list.
#
# This used to be `len(hits) / len(skills)`, which made breadth a penalty: the
# identical Full Stack listing scored 65 for a candidate with 17 skills and 88
# for one with 3, because the strong candidate's own skill count was the
# denominator. Nearly nobody real could clear the default 65 threshold — a live
# run scraped 49 Internshala listings and matched zero, every one of them
# scoring around 21.
RELEVANCE_SATURATION = 3

# What a title naming the candidate's own field is worth, counted in the same
# units as RELEVANCE_SATURATION (so 2 of 3 = strong, but never a full match).
#
# Measured: Zypp Electric published a "Data Science Intern" role with a
# 119-character description. There is nothing in that page for keyword overlap
# to find, so an ML candidate scored 12 on a role written for them. Meanwhile a
# 6000-character "B2B Sales intern" scored 0 correctly — length is not quality.
# An employer who names the field in the TITLE has stated the role's subject
# more directly than any keyword buried in prose, so that deserves to count as
# evidence rather than a 0.12 garnish. Deliberately below saturation: a listing
# that actually names the candidate's stack must always outrank a bare title.
TITLE_DOMAIN_RELEVANCE = 2


# What a listing may call a domain instead of the name the user picked in
# onboarding. Every entry is a WHOLE PHRASE, never a bare token: the loose
# "any token overlaps" test this replaced fired on the word "development"
# alone, so every "<Anything> Development Internship" collected the bonus.
#
# The measured cost of not having this: a real "Data Science Intern" scored
# **0** for a candidate whose domains include Machine Learning and whose
# skills list names machine learning, deep learning and computer vision —
# because no employer writes "Machine Learning Intern" when they mean a data
# scientist. Nothing here is a guess about the candidate; it is only a
# vocabulary for the field they already chose.
_DOMAIN_SYNONYMS: dict[str, tuple[str, ...]] = {
    "machine learning": (
        "data science", "data scientist", "ml engineer", "ml intern",
        "deep learning", "artificial intelligence", "nlp",
        "natural language processing", "computer vision", "generative ai",
    ),
    "artificial intelligence": (
        "machine learning", "data science", "deep learning", "ai engineer",
        "ai intern", "generative ai", "llm", "nlp", "computer vision",
    ),
    "data science": (
        "machine learning", "data analyst", "data analytics", "analytics",
        "business intelligence", "deep learning",
    ),
    "web development": (
        "full stack", "fullstack", "frontend", "front end", "backend",
        "back end", "web developer", "mern", "mean stack",
    ),
    "frontend development": (
        "front end", "frontend", "ui developer", "react developer",
        "web developer", "full stack", "fullstack",
    ),
    "backend development": (
        "back end", "backend", "api developer", "server side",
        "full stack", "fullstack",
    ),
    "mobile development": (
        "android", "ios", "flutter", "react native", "mobile app",
        "app developer",
    ),
    "ui/ux design": (
        "ui ux", "uiux", "product design", "user experience",
        "user interface", "figma",
    ),
    "devops": (
        "site reliability", "sre", "platform engineer", "infrastructure",
        "cloud engineer",
    ),
    "cyber security": (
        "cybersecurity", "security engineer", "infosec",
        "information security", "application security", "soc analyst",
    ),
}


def _domain_hit(domains: list[str], haystack: str, hay_tokens: set[str]) -> bool:
    """True only if a whole domain phrase is present — every token of it, not
    just one. A loose `any token overlaps` test fired on the word "development"
    alone, so every "<Anything> Development Internship" collected the domain
    bonus regardless of field.

    A listing also counts when it uses one of the field's own synonyms (see
    _DOMAIN_SYNONYMS) — employers name the job, not the taxonomy.
    """
    for d in domains:
        dt = _tokens(d)
        if not dt:
            continue
        if _norm(d).strip() in haystack or dt <= hay_tokens:
            return True
        for phrase in _DOMAIN_SYNONYMS.get(_norm(d).strip(), ()):
            # Substring on the normalised haystack, same test as the domain
            # itself, so a multi-word synonym cannot fire on one of its words.
            if phrase in haystack:
                return True
    return False


def _experience_penalty(title: str, exp_level: str | None) -> float:
    """Adjust score based on seniority vs candidate level (-0.15 to +0.05)."""
    if not exp_level:
        return 0.0
    low = title.lower()
    senior_kw = {"senior", "lead", "principal", "head", "manager", "director", "staff"}
    entry_kw = {"intern", "junior", "fresher", "trainee", "entry", "graduate"}
    is_senior = any(k in low for k in senior_kw)
    is_entry = any(k in low for k in entry_kw)
    if exp_level in ("student", "fresher"):
        if is_senior:
            return -0.15
        if is_entry:
            return +0.05
    elif exp_level == "1-2yr":
        if is_senior:
            return -0.05
    return 0.0


def score_job(
    job: dict,
    skills: list[str],
    domains: list[str],
    exp_level: str | None = None,
    jd_text: str = "",
) -> tuple[int, str]:
    """Return (0-100, human reason). jd_text enriches scoring when available."""
    skills = [_alias(s) for s in skills]
    job_skills = [_alias(s) for s in (job.get("skills") or [])]
    haystack = " ".join(
        [_norm(job.get("title", "")), job.get("company", ""), " ".join(job_skills)]
    ).lower()
    if jd_text:
        # 6000, not 800. An 800-character window covers a board card's blurb but
        # only the navigation and boilerplate of a real posting page — the
        # requirements section, which is the only part naming the stack, sits
        # well below it. Employer-hosted internships (DevRev, CloudSEK, Thena,
        # Enterpret) therefore scored 5-17 against a threshold of 65 with the
        # candidate's own skills printed further down the same page. Bounded so
        # a pathological page cannot make scoring quadratic. Shared with the
        # semantic pass so both halves of scoring read the same posting.
        haystack += " " + _norm(jd_text[:_JD_WINDOW])
    hay_tokens = _tokens(haystack)

    if not skills:
        return 50, "no skills extracted yet; neutral score"

    # 1) relevance — how many of the candidate's skills this listing mentions.
    #    Saturating count, NOT a fraction of their skill list: see
    #    RELEVANCE_SATURATION. A candidate with more skills must never score
    #    lower than a narrower one on the same job.
    hits = [sk for sk in skills if sk in haystack or hay_tokens & _tokens(sk)]
    relevance = min(1.0, len(hits) / RELEVANCE_SATURATION)

    #    A title that names the candidate's own field is evidence in itself —
    #    see TITLE_DOMAIN_RELEVANCE. Applied as a FLOOR, never an addition, so
    #    a listing that genuinely names their stack is unaffected and always
    #    ranks higher than one carrying only a well-aimed title.
    title_hay = _norm(job.get("title", ""))
    title_domain = bool(domains) and _domain_hit(domains, title_hay, _tokens(title_hay))
    if title_domain:
        relevance = max(relevance, TITLE_DOMAIN_RELEVANCE / RELEVANCE_SATURATION)

    # 2) coverage — of what the ROLE asks for, how much does the candidate have.
    #    None (not 0.0) when the listing declares no skills at all, so "we don't
    #    know what this role wants" doesn't read as "the candidate has none of it".
    js_hits = [s for s in job_skills if s in skills or _tokens(s) & set(skills)]
    coverage = len(js_hits) / len(job_skills) if job_skills else None

    # 3) domain alignment
    domain_hit = _domain_hit(domains, haystack, hay_tokens) if domains else False

    if coverage is None:
        base = 0.75 * relevance
    else:
        base = 0.50 * coverage + 0.35 * relevance
    if domain_hit:
        base += 0.12

    # 4) experience level adjustment
    base += _experience_penalty(job.get("title", ""), exp_level)

    # 5) semantic bonus — TF-IDF cosine(skills, JD text) when the JD is available.
    #    Additive, never a haircut. The old form was `base = 0.70*base + 0.30*semantic`,
    #    but a cosine between a bag of skill words and prose is structurally low
    #    (0.05-0.25 even for a perfect fit), so that blend almost always *lowered*
    #    the score — reading the job description could only ever hurt a listing.
    if jd_text:
        semantic = _tfidf_score(" ".join(skills), jd_text)
        if semantic > 0:
            base += 0.15 * min(1.0, semantic * 2.5)

    score = int(round(min(1.0, max(0.0, base)) * 100))

    if hits:
        reason = "matches " + ", ".join(hits[:4])
    elif title_domain:
        # Never "weak skill overlap" for a listing that scored on its title:
        # the user reads this line to decide whether to trust the match, and
        # naming the real evidence is the difference between a reason and an
        # excuse. An under-described posting is exactly where they most need
        # to know the score came from the title alone.
        reason = "the role itself is in your field, though the posting says little"
    else:
        reason = "weak skill overlap"

    # transparent breakdown — surfaced verbatim in the dashboard so the user can
    # see *why* a job scored the way it did (and contest a bad match).
    parts = [f"{len(hits)} of your skills mentioned"]
    if job_skills:
        parts.append(f"{len(js_hits)}/{len(job_skills)} role skills")
    parts.append("domain ✓" if domain_hit else "domain ✗")
    exp_adj = _experience_penalty(job.get("title", ""), exp_level)
    if exp_adj > 0:
        parts.append("level fit ✓")
    elif exp_adj < 0:
        parts.append("level mismatch ✗")
    reason = f"{reason} · " + ", ".join(parts)
    return score, reason


def missing_skills(job: dict, skills: list[str], jd_text: str = "") -> list[str]:
    """What this role asks for that the candidate does not show.

    The actionable half of a match score. "You scored 72" tells someone nothing they
    can do anything about; "this role wants Docker and Kubernetes, and you show
    neither" tells them what to go learn, and what they'll be asked about if they
    get the call. Same matching rules as score_job, so the two can never disagree
    about what counts as a hit.
    """
    skills = [_alias(s) for s in skills]
    skill_tokens = set(skills)
    for s in skills:
        skill_tokens |= _tokens(s)

    job_skills = [_alias(s) for s in (job.get("skills") or [])]
    if jd_text:
        # The listing card often declares nothing; the JD is where the real
        # requirements are written down.
        low = _norm(jd_text)
        for known in _KNOWN_FOR_GAP:
            if known in low and known not in job_skills:
                job_skills.append(known)

    out: list[str] = []
    for s in job_skills:
        if s in skills or (_tokens(s) & skill_tokens):
            continue
        if s not in out:
            out.append(s)
    return out[:6]


def _fuzzy_company_match(company: str, excluded: str) -> bool:
    """Return True if excluded name looks like the same company as company."""
    c = company.lower().strip()
    e = excluded.lower().strip()
    if not e:
        return False
    # An unscraped company name matches nothing. Without this, `c in e` below is
    # True for every exclusion the moment c is "" — so a listing whose company
    # failed to scrape was firewall-blocked as an "excluded company" as soon as
    # the user excluded any employer at all.
    if not c:
        return False
    # exact substring match in either direction
    if e in c or c in e:
        return True
    # first-word match (e.g. "Acme" matches "Acme Corp Ltd")
    c_words = c.split()
    e_words = e.split()
    if c_words and e_words and c_words[0] == e_words[0]:
        return True
    return False


def firewall_block(job: dict, profile: dict) -> str | None:
    """Return a block reason if a hard constraint forbids applying, else None."""
    excluded = _json_list(profile.get("excluded_companies"))
    company = job.get("company", "")
    if any(_fuzzy_company_match(company, e) for e in excluded):
        return f"excluded company {company}"

    work_mode = profile.get("work_mode") or "any"
    loc = (job.get("location") or "").lower()
    if work_mode == "remote" and "remote" not in loc and "work from home" not in loc:
        return "not remote"
    if work_mode == "onsite" and ("remote" in loc or "work from home" in loc):
        return "remote, wanted onsite"

    stipend_min = int(profile.get("stipend_min") or 0)
    if stipend_min > 0:
        amt = _parse_stipend(job.get("stipend"))
        if amt is not None and amt < stipend_min:
            return f"stipend ₹{amt} < min ₹{stipend_min}"

    return None


def _json_list(v) -> list[str]:
    if not v:
        return []
    try:
        return json.loads(v) if isinstance(v, str) else list(v)
    except Exception:  # noqa: BLE001
        return []


def _unit_mult(unit: str) -> int:
    if unit == "k":
        return 1_000
    if unit in ("l", "lpa", "lakh", "lac"):
        return 100_000
    return 1


def _parse_stipend(s) -> int | None:
    # Mirrors src/lib/firewall.ts:parseStipend — keep the two in sync.
    #  - "unpaid"/"none" -> 0; units: "10k" -> 10000, "6 LPA" -> 600000
    #  - ranges: "10-15k" -> 10000 (trailing unit governs BOTH ends, so the
    #    low bound is not misread as ₹10 and used to wrongly block a stipend)
    #  - returns None only when no figure is present (unknown -> not gated)
    if not s:
        return None
    st = str(s).lower()
    if re.search(r"\b(unpaid|none|no stipend|nil)\b", st):
        return 0
    # Ranges and loose figures are kept apart on purpose — see the return below.
    range_lows: list[int] = []
    loose: list[int] = []
    consumed: list[tuple[int, int]] = []
    for mm in re.finditer(r"(\d[\d,]*\.?\d*)\s*(?:-|–|—|to)\s*(\d[\d,]*\.?\d*)\s*(k|l|lpa|lakh|lac)?", st):
        mult = _unit_mult(mm.group(3) or "")
        ends: list[int] = []
        for num in (mm.group(1), mm.group(2)):
            try:
                ends.append(int(round(float(num.replace(",", "")) * mult)))
            except ValueError:
                continue
        if ends:
            range_lows.append(min(ends))
        consumed.append((mm.start(), mm.end()))
    for mm in re.finditer(r"(\d[\d,]*\.?\d*)\s*(k|l|lpa|lakh|lac)?", st):
        if any(cs <= mm.start() < ce for cs, ce in consumed):
            continue
        try:
            v = float(mm.group(1).replace(",", ""))
        except ValueError:
            continue
        loose.append(int(round(v * _unit_mult(mm.group(2) or ""))))

    # A stated RANGE gives its low end: "10-15k" is 10000, because that is what
    # the candidate is actually guaranteed and the floor is what stipend_min is
    # asking about.
    if range_lows:
        return min(range_lows)
    # Loose figures are a different problem. Everything unconsumed lands here,
    # including durations and counts, so the old min() over the combined list
    # read "₹15,000 /month for 6 months" as a stipend of 6 and firewall_block
    # rejected a good listing for underpaying. "3 month internship" and "2
    # openings" did the same. Durations and counts are small and a monthly
    # stipend is not, so the largest figure is the stipend far more often than
    # the smallest is.
    return max(loose) if loose else None
