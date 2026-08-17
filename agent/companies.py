"""Company packs — what a named employer publishes about how it hires.

The legal shape of this file is as important as its contents, so it is worth
being explicit about what it is and is not.

WHAT IT IS: a hand-curated index of things companies have published themselves,
each row carrying the URL it came from. Amazon publishes its Leadership
Principles; Google publishes its hiring-process pages; Zoho publishes how its
schools programme works. Referring to those factually, by name, with a link, is
nominative fair use. Nothing here is copied at length, and every claim is short
enough to be a statement of fact rather than an expressive work.

WHAT IT IS NOT: scraped data. There is no crawler behind this module and there
must never be one. LinkedIn, Naukri, Indeed and Glassdoor all forbid scraping in
their terms, and that exposure is precisely what this product exists to leave
behind. It is also not insider knowledge, not "what gets you hired", and not a
prediction. A company pack tells the user what an employer has said it looks for
and whether their resume currently shows it. That is a checkable claim; "this
resume will get you into Qualcomm" is not, and we never make it.

WHAT IT IS NOT, PART TWO: an endorsement. Every pack renders behind a standing
disclaimer that Grindly is not affiliated with, endorsed by, or partnered with
any company named here. Trademarks belong to their owners and appear only to
identify the employer a user is applying to.

`curated_on` is the date a human last read the source page and confirmed the
claim. It is shown in the UI beside the link so a user can see how stale it is
and check for themselves — a company reorganising its careers site should look
like out-of-date guidance, not like confident guidance.

Adding a company: keep `emphasis` to what the sources actually support, keep
`keywords` to vocabulary the employer itself uses, and never write an `emphasis`
line that instructs a rewrite to claim experience. The rewrite gates in
`resume_optimize` will strip an invented fact anyway, but a prompt that asks for
one wastes a variant and teaches the model the wrong job.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict

CURATED_ON = "2026-08-16"

DISCLAIMER = (
    "Grindly is not affiliated with, endorsed by, or partnered with any company "
    "named here. Company names and trademarks belong to their owners and are "
    "used only to identify the employer you are applying to. Every claim below "
    "links to the company's own published material — open it and check."
)


@dataclass
class Source:
    """One published claim and where it was published."""
    claim: str
    url: str
    curated_on: str = CURATED_ON


@dataclass
class CompanyPack:
    slug: str
    name: str
    # One line the user reads before deciding whether this pack is for them.
    summary: str
    # What the sources support surfacing. Fed to the rewrite as emphasis, never
    # as permission to add anything.
    emphasis: list[str]
    # Vocabulary the employer itself uses. Used for coverage scoring, so these
    # must be words a recruiter would actually search, not aspirations.
    keywords: list[str]
    sources: list[Source]
    # Roles this pack is written for. A pack tuned to embedded silicon is wrong
    # advice for a marketing applicant, and the UI says so.
    best_for: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["sources"] = [asdict(s) if not isinstance(s, dict) else s for s in self.sources]
        return d


PACKS: list[CompanyPack] = [
    CompanyPack(
        slug="amazon",
        name="Amazon",
        summary="Interviews are explicitly structured around 16 published Leadership Principles, and candidates are asked for specific past examples rather than hypotheticals.",
        emphasis=[
            "Rewrite each bullet as a complete situation-action-result: what the problem was, what you personally did, and what changed as a result.",
            "Use first-person singular ownership language for work you did yourself — 'I built', not 'we built' — where the source already makes your individual role clear.",
            "Lead with the bullets that show you owned something end to end and dug into detail, since Ownership and Dive Deep are named principles.",
            "Keep every real number prominent; the interview loop asks for specifics and a resume that already states them is easier to talk to.",
        ],
        keywords=["ownership", "customer", "scale", "distributed systems", "aws", "java", "python", "data structures", "algorithms", "system design"],
        sources=[
            Source("Amazon publishes 16 Leadership Principles and states they are used throughout hiring.", "https://www.amazon.jobs/content/en/our-workplace/leadership-principles"),
            Source("Amazon's interview guidance asks candidates to prepare specific examples from their own experience and to use a structured answer format.", "https://www.amazon.jobs/content/en/how-we-hire/interviewing-at-amazon"),
        ],
        best_for=["software", "data", "operations", "product"],
    ),
    CompanyPack(
        slug="qualcomm",
        name="Qualcomm",
        summary="Hires heavily into silicon, embedded and wireless engineering; postings routinely name specific hardware description languages, protocols and toolchains.",
        emphasis=[
            "Promote embedded, silicon and systems work to the top: RTL, verification, firmware, drivers, DSP, C and C++ depth.",
            "Name the exact tools, protocols and standards your projects used — a keyword search here is for specific technology names, not general skills.",
            "Demote web and app work below hardware-adjacent work unless the target role is explicitly software.",
            "Surface any coursework, thesis, publication or patent that touches signal processing, computer architecture or wireless.",
        ],
        keywords=["c", "c++", "rtl", "verilog", "systemverilog", "verification", "firmware", "embedded", "dsp", "signal processing", "computer architecture", "linux kernel", "device drivers", "python"],
        sources=[
            Source("Qualcomm's careers site organises openings by engineering discipline including hardware, software and systems engineering.", "https://careers.qualcomm.com/careers"),
            Source("Qualcomm publishes a university and early-career hiring track for students and recent graduates.", "https://careers.qualcomm.com/university"),
        ],
        best_for=["embedded", "hardware", "systems", "software"],
    ),
    CompanyPack(
        slug="google",
        name="Google",
        summary="Publishes its own resume guidance, which asks for the X-Y-Z form: accomplished X, measured by Y, by doing Z.",
        emphasis=[
            "Rewrite bullets into the form Google itself publishes: accomplished [X], as measured by [Y], by doing [Z].",
            "Put the measurable outcome in the same sentence as the action rather than in a separate line.",
            "Keep the resume to the roles and projects most relevant to the target role; Google's guidance asks for relevance over completeness.",
            "Name the languages and systems used per project, since screening is role-specific.",
        ],
        keywords=["algorithms", "data structures", "distributed systems", "c++", "java", "python", "go", "machine learning", "system design", "scalability"],
        sources=[
            Source("Google publishes resume guidance recommending the 'accomplished X as measured by Y by doing Z' bullet form.", "https://www.google.com/about/careers/applications/how-we-hire/"),
            Source("Google documents its hiring process stages publicly.", "https://www.google.com/about/careers/applications/hiring-process/"),
        ],
        best_for=["software", "data", "research", "product"],
    ),
    CompanyPack(
        slug="microsoft",
        name="Microsoft",
        summary="Screens broadly across cloud, product and engineering; publishes a university hiring track with role-specific requirements.",
        emphasis=[
            "Lead with collaboration and cross-team impact where the source already shows it — growth mindset and teamwork appear throughout Microsoft's published material.",
            "Name cloud and platform experience explicitly, especially Azure, .NET, C# and TypeScript where they are genuinely present.",
            "Keep one line per project on what the user actually shipped and who used it.",
        ],
        keywords=["azure", "c#", ".net", "typescript", "python", "cloud", "distributed systems", "data structures", "algorithms", "system design"],
        sources=[
            Source("Microsoft publishes a students-and-graduates careers track with role families and application guidance.", "https://careers.microsoft.com/v2/global/en/students.html"),
            Source("Microsoft describes its interview process and what candidates are assessed on.", "https://careers.microsoft.com/v2/global/en/interviewtips.html"),
        ],
        best_for=["software", "cloud", "data", "product"],
    ),
    CompanyPack(
        slug="tcs",
        name="Tata Consultancy Services",
        summary="Recruits at very large scale through the NQT assessment; screening weights degree, branch, percentage and standard skill vocabulary heavily.",
        emphasis=[
            "Put education, branch, CGPA or percentage and graduation year in a clearly labelled block near the top — these are the fields the screen filters on first.",
            "State the standard skill vocabulary plainly in a Technical Skills section rather than only inside project prose.",
            "Keep the resume to one page and to standard headings; volume screening rewards a document that parses cleanly over one that looks distinctive.",
            "Name any certification by its full official title.",
        ],
        keywords=["java", "python", "sql", "dbms", "operating systems", "oops", "data structures", "c", "cloud", "testing", "agile"],
        sources=[
            Source("TCS runs the National Qualifier Test as the entry route for its large-scale graduate hiring.", "https://www.tcs.com/careers/india/tcs-nqt"),
            Source("TCS publishes its careers and eligibility information for graduate applicants.", "https://www.tcs.com/careers"),
        ],
        best_for=["software", "it services", "support"],
    ),
    CompanyPack(
        slug="infosys",
        name="Infosys",
        summary="Hires graduates at scale through published assessment tracks; role families and eligibility are documented on its careers site.",
        emphasis=[
            "Make education, branch and graduation year unmissable and machine-readable near the top.",
            "List the core computer-science subjects and languages explicitly — screening vocabulary here is standard and literal.",
            "Give each project a one-line statement of what it does and which technologies built it.",
            "Keep formatting plain: one column, standard headings, no graphics.",
        ],
        keywords=["java", "python", "sql", "data structures", "algorithms", "dbms", "operating systems", "cloud", "agile", "testing"],
        sources=[
            Source("Infosys publishes its graduate hiring tracks and eligibility criteria.", "https://www.infosys.com/careers/apply.html"),
            Source("Infosys documents its careers process for students and freshers.", "https://www.infosys.com/careers.html"),
        ],
        best_for=["software", "it services", "consulting"],
    ),
    CompanyPack(
        slug="zoho",
        name="Zoho",
        summary="Publicly emphasises skill over credential, including through Zoho Schools; assessments weigh demonstrated problem-solving.",
        emphasis=[
            "Lead with what you have actually built and shipped rather than with coursework or grades.",
            "Give every project a concrete outcome — who used it, what it replaced, what it measured.",
            "Name languages and stacks precisely; depth in a few beats a long shallow list.",
            "Do not pad with certifications; the published emphasis is on demonstrated ability.",
        ],
        keywords=["java", "python", "javascript", "sql", "data structures", "algorithms", "problem solving", "full stack", "linux"],
        sources=[
            Source("Zoho publishes Zoho Schools of Learning, its skill-first alternative hiring and training route.", "https://www.zoho.com/schools/"),
            Source("Zoho's careers site describes its hiring approach and open roles.", "https://www.zoho.com/careers/"),
        ],
        best_for=["software", "product", "support"],
    ),
    CompanyPack(
        slug="flipkart",
        name="Flipkart",
        summary="Consumer-scale e-commerce engineering; postings emphasise scale, reliability and ownership of a service end to end.",
        emphasis=[
            "Surface anything that ran at scale or under load, with the real numbers already in the source.",
            "Name backend and distributed-systems work explicitly — services, queues, caching, databases.",
            "Show end-to-end ownership of a component rather than a list of tasks.",
        ],
        keywords=["java", "distributed systems", "microservices", "kafka", "redis", "sql", "system design", "scalability", "aws", "python"],
        sources=[
            Source("Flipkart publishes its careers site with engineering role families and locations.", "https://www.flipkartcareers.com/"),
        ],
        best_for=["software", "data", "product"],
    ),
    CompanyPack(
        slug="deloitte",
        name="Deloitte",
        summary="Professional services hiring across consulting, audit, risk and technology; published guidance emphasises clarity and relevance.",
        emphasis=[
            "Lead with client-facing, analytical and communication work where the source already shows it.",
            "Quantify scope: team size, duration, budget, number of stakeholders — whatever the source actually states.",
            "Name the domain, not just the tool: 'financial reporting', 'supply chain', 'cyber risk'.",
            "Keep the document conservative in formatting; this is a screening environment that rewards convention.",
        ],
        keywords=["consulting", "analytics", "excel", "sql", "power bi", "tableau", "risk", "audit", "stakeholder management", "process improvement"],
        sources=[
            Source("Deloitte publishes careers guidance and role families for students and graduates.", "https://www2.deloitte.com/global/en/careers/students.html"),
        ],
        best_for=["consulting", "analytics", "finance", "operations"],
    ),
    CompanyPack(
        slug="accenture",
        name="Accenture",
        summary="Large-scale technology and consulting hiring; role postings name specific platforms and certifications.",
        emphasis=[
            "Name platforms and certifications by their exact official titles — screening here is literal.",
            "Show delivery: what was implemented, for what kind of client, over what period.",
            "Keep a clearly labelled Technical Skills block; a platform named only inside prose is easy to miss.",
        ],
        keywords=["sap", "salesforce", "aws", "azure", "java", "python", "sql", "agile", "devops", "cloud", "automation"],
        sources=[
            Source("Accenture publishes its careers site with role families, locations and graduate programmes.", "https://www.accenture.com/in-en/careers"),
        ],
        best_for=["software", "consulting", "it services"],
    ),
    # ---- added 2026-08-17 ------------------------------------------------
    # Every URL below was fetched on that date and the claim beside it is what
    # that page actually said. A pack whose source 404s is worse than no pack:
    # the whole reason this file exists is that the user can open the link and
    # check. If one of these goes dead, delete the pack rather than leaving a
    # citation nobody can follow.
    CompanyPack(
        slug="adobe",
        name="Adobe",
        summary="Publishes a five-stage hiring process and tells applicants in as many words to make sure their resume shows every relevant qualification.",
        emphasis=[
            "Make the qualifications the posting names findable on the first read — Adobe's own guidance is to ensure the resume highlights all of them.",
            "Give each role a concrete example of something you delivered, since later rounds ask you to talk through past work with the hiring manager and the team.",
            "Name the craft tools your work actually used; assessments here are role-specific rather than one standard test.",
        ],
        keywords=["product design", "creative cloud", "javascript", "java", "python", "c++", "machine learning", "adobe experience manager", "ux", "prototyping"],
        sources=[
            Source("Adobe publishes a five-step hiring process — profile, talent partner conversation, hiring manager interview, role-specific assessment, offer — and advises applicants to 'ensure your resume highlights all of your relevant qualifications'.", "https://careers.adobe.com/us/en/hiring-process", "2026-08-17"),
        ],
        best_for=["software", "design", "product", "data"],
    ),
    CompanyPack(
        slug="netflix",
        name="Netflix",
        summary="Screens against a published culture document rather than a competency grid; it names the behaviours it selects for and expects people to work with unusual autonomy.",
        emphasis=[
            "Lead with work you drove yourself with little supervision — the culture document is explicit about autonomy and thin process.",
            "Show judgement: why you chose an approach, not only what you built.",
            "Where the source already shows it, surface the moment you told someone something they did not want to hear, or handed work to whoever was best placed to do it.",
            "Keep the page short and unpadded; the same document is blunt about preferring substance to volume.",
        ],
        keywords=["judgment", "selflessness", "candor", "ownership", "distributed systems", "java", "python", "scala", "microservices", "streaming"],
        sources=[
            Source("Netflix publishes its culture document, which names judgment, selflessness and candor among the behaviours it selects for and describes an environment of high autonomy with minimal process.", "https://jobs.netflix.com/culture", "2026-08-17"),
        ],
        best_for=["software", "data", "product", "content"],
    ),
    CompanyPack(
        slug="uber",
        name="Uber",
        summary="Publishes a six-step hiring process, and states what each stage is assessing — experience, problem solving, technical skill and how you work with other people.",
        emphasis=[
            "Structure each bullet so the problem and your approach are both visible; problem solving is named as a separate thing they assess.",
            "Put the collaboration explicitly on the page where the source shows it — who you worked with, and on what.",
            "Keep the technical detail concrete for engineering roles: the stack, the scale, the part you owned.",
        ],
        keywords=["distributed systems", "go", "java", "python", "kotlin", "swift", "microservices", "system design", "data engineering", "scalability"],
        sources=[
            Source("Uber publishes a six-step hiring process and states that it assesses experience, problem-solving, technical ability for technical roles, job-related competencies and collaboration.", "https://jobs.uber.com/en/what-moves-us/how-we-hire/", "2026-08-17"),
        ],
        best_for=["software", "data", "operations", "product"],
    ),
    CompanyPack(
        slug="wipro",
        name="Wipro",
        summary="Recruits along two clearly separated tracks — early careers and experienced professionals — into delivery work on global client projects.",
        emphasis=[
            "Make it obvious in the first three lines which track you are: graduation year and degree for early careers, years and domain for experienced.",
            "Name the client-facing part of your work where the source shows it — delivery, not only build.",
            "State the standard skill vocabulary plainly in a Technical Skills block; large-scale screening reads literally.",
            "Keep formatting conventional: one column, standard headings, no graphics.",
        ],
        keywords=["java", "python", "sql", "cloud", "aws", "azure", "devops", "testing", "agile", "sap", "servicenow", "cybersecurity"],
        sources=[
            Source("Wipro's careers site organises hiring into early-careers and experienced-professional tracks across global client projects.", "https://careers.wipro.com/", "2026-08-17"),
        ],
        best_for=["software", "it services", "consulting", "support"],
    ),
    CompanyPack(
        slug="cognizant",
        name="Cognizant",
        summary="Separates its hiring into students and new graduates, experienced professionals, alumni and consulting — the track you apply through shapes what the screen looks for.",
        emphasis=[
            "Match the page to the track: coursework, projects and graduation year for a new graduate; domain, client and duration for a professional.",
            "Name the industry you worked in, not only the technology — this is consulting-shaped hiring and the domain is part of the match.",
            "Give each engagement a one-line statement of what was delivered and over what period.",
        ],
        keywords=["java", "python", "sql", "cloud", "aws", "azure", "salesforce", "sap", "data engineering", "agile", "healthcare", "banking"],
        sources=[
            Source("Cognizant's careers site presents distinct hiring tracks for students and new graduates, professionals, alumni and consulting professionals.", "https://careers.cognizant.com/global-en/", "2026-08-17"),
        ],
        best_for=["software", "it services", "consulting", "analytics"],
    ),
    CompanyPack(
        slug="razorpay",
        name="Razorpay",
        summary="Publishes an 'Outgrow Ordinary' careers philosophy and describes compensation as merit-based and tied to output, which puts the weight on what you shipped.",
        emphasis=[
            "Lead with what you shipped and what it did, rather than with the role you held — the stated philosophy ties reward to output.",
            "Surface fintech, payments or high-throughput work where the source already shows it.",
            "Keep the numbers you have: volume, latency, uptime, users. This is a payments company and scale is the vocabulary.",
            "Show the part you owned end to end rather than a list of contributions.",
        ],
        keywords=["payments", "fintech", "golang", "java", "python", "kubernetes", "aws", "kafka", "system design", "api", "microservices"],
        sources=[
            Source("Razorpay's careers site publishes an 'Outgrow Ordinary' philosophy built on Build, Grow and Live Extraordinary, and describes merit-based compensation tied to output.", "https://razorpay.com/jobs/", "2026-08-17"),
        ],
        best_for=["software", "fintech", "product", "data"],
    ),
    CompanyPack(
        slug="samsung",
        name="Samsung",
        summary="Organises openings by job field and hires heavily into its R&D centres, so the field you are applying into matters more than a general engineering profile.",
        emphasis=[
            "Put the specialisation first — embedded, semiconductor, mobile, display, AI — since openings are organised by field rather than by seniority.",
            "Name the hardware, protocols and toolchains your projects used; an R&D screen searches for specific technology names.",
            "Surface any thesis, publication or patent, which is ordinary currency in an R&D organisation.",
            "Keep device and platform work above general web work unless the role is explicitly software.",
        ],
        keywords=["embedded", "c", "c++", "android", "linux kernel", "device drivers", "semiconductor", "signal processing", "computer vision", "machine learning", "rtos", "verilog"],
        sources=[
            Source("Samsung India's careers site organises its openings by job field and names its R&D centres among its business areas.", "https://www.samsung.com/in/careers/", "2026-08-17"),
        ],
        best_for=["embedded", "hardware", "research", "software"],
    ),
]

BY_SLUG = {p.slug: p for p in PACKS}


def list_packs() -> list[dict]:
    """Every pack, as plain dicts, for the API and the picker UI."""
    return [p.to_dict() for p in PACKS]


def get_pack(slug: str) -> dict | None:
    pack = BY_SLUG.get((slug or "").strip().lower())
    return pack.to_dict() if pack else None


def search(query: str) -> list[dict]:
    """Packs whose name or slug matches. Used by the company picker's type-ahead."""
    q = (query or "").strip().lower()
    if not q:
        return list_packs()
    return [p.to_dict() for p in PACKS if q in p.slug or q in p.name.lower()]
