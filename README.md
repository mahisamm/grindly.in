# Grindly

**See your resume the way a machine reads it.**

Upload a resume. Grindly measures what a parser can actually recover from the
file, rebuilds it as a clean single-column PDF, scores the rebuild on the same
ruler, and tailors it to a named company — without inventing a single fact.

---

## The claim this product refuses to make

There is no such thing as an ATS score.

Workday, Greenhouse, iCIMS, Lever and Taleo parse a resume into database fields
and let a recruiter search them. They do not grade resumes and they do not
auto-reject on a score. A 2026 survey found 92% of recruiters review
applications manually; only 2 of 25 had their ATS configured to reject on
content at all. The famous "75% of resumes never reach a human" line traces to a
2012 sales pitch from a company that shut down in 2013.

So every tool selling an "82/100 ATS score" is selling a number no system
anywhere computes — and, worse for whoever has to maintain it, a number that
cannot be debugged.

Grindly measures two things that are checkable instead:

- **The Grindly Readiness Score** — a published rubric over five bands, computed
  by `agent/readiness.py`. It is a pure function: the same bytes give the same
  number on every machine, every run.
- **Parse fidelity** — we render your rebuilt resume to PDF, read it back with
  the same extractor a parser uses, and count how many of your facts survived.
  *"A parser recovered 47 of your 51 facts"* is a fact about two files.

The previous scorer was an LLM ensemble. Its own source comments recorded the
same unchanged document scoring 70, 76 and 88 on three consecutive runs, and the
rewrite pipeline carried a ±6 fudge factor to stop that wobble discarding good
rewrites. A ruler that moves ±9 cannot measure an 8-point improvement.

---

## What it will not do

- **It is built not to invent.** Three gates run before any rewrite is rendered:
  no technology absent from your resume, no employer/school/date/metric whose
  words are not in your source, and every entry must descend from a real one on
  the master. `agent/tests/test_gates.py` measures both directions — the
  fabrications that must be blocked, and the honest rewordings that must
  survive.

  The honest limit: the gates catch any technology in the ~450-name vocabulary
  in any case, any capitalised proper noun, any acronym, any number, any
  employer or date, and any entry with no ancestor. They do not catch a
  lower-case product name that is absent from the vocabulary and reads as an
  ordinary English word. This file used to say invention was impossible; an
  adversarial review then walked nine fabrications out of twenty-six through the
  gates, so the claim is now the one the code actually supports. Read what the
  tool produces before you send it.
- **It will not auto-apply.** Bulk-submitting through job boards breaks their
  terms and gets user accounts banned. Grindly hands you the document; you send
  it.
- **It will not scrape.** Company packs are hand-curated from what employers
  publish themselves, each claim carrying its source URL and the date a human
  last checked it.

---

## Architecture

```
Browser ── Next.js 16 (App Router, TS, Tailwind v4)
              │
              ├── Postgres (Prisma)
              │
              └── agent/cli.py            one spawn, JSON in, JSON out
                     ├── readiness.py     the score — pure, no model, no I/O
                     ├── render_pdf.py    struct → HTML → Chromium → PDF
                     ├── resume_optimize  rewrite + the three gates
                     ├── resume_parse     PDF/DOCX/TXT extraction
                     ├── jobspec.py       pasted JD → requirements
                     ├── companies.py     curated packs, with sources
                     ├── llm.py           4 free-tier providers, ensembled
                     └── redact.py        PII stripped at the model boundary
```

Python is a pure function of its input: no database, no queue, no worker fleet.
The web app spawns it, writes one JSON object, reads one back. The previous
build reached Python through a Postgres job queue drained by long-lived workers,
because applying to a job board takes minutes and fails halfway. Reading a
resume takes under a second and either works or doesn't.

```
src/
├─ app/
│  ├─ page.tsx            Landing
│  ├─ login, signup       Email + password, Google optional
│  ├─ app/                The workspace (upload → report → rewrite → target)
│  ├─ pricing/            Season Pass checkout
│  ├─ admin/              One page: config, usage, errors
│  └─ api/                resumes · variants · companies · pay · auth · health
├─ lib/
│  ├─ agent.ts            The subprocess bridge
│  ├─ readiness types     reportTypes.ts — shared, no Node imports
│  ├─ auth.ts             requireUser / requireAdmin
│  ├─ plans.ts            Passes, limits, pricing
│  ├─ quota.ts            Reserve-then-refund daily ceilings
│  └─ payment.ts          Razorpay, or a stub by default
└─ components/Score.tsx   The dial, the bands, the findings
```

---

## Run it locally

**Prerequisites:** Node 18+, Python 3.10+, Docker (or a local Postgres).

```bash
# 1. Database
docker run -d --name grindly-postgres \
  -e POSTGRES_USER=grindly -e POSTGRES_PASSWORD=grindly_local -e POSTGRES_DB=grindly \
  -p 5432:5432 -v grindly_pgdata:/var/lib/postgresql/data postgres:16-alpine

# 2. Config
cp .env.example .env
npm run setup            # generates APP_ENCRYPTION_KEY, installs everything,
                         # runs prisma db push

# 3. Go
npm run dev              # http://localhost:3000
```

`npm run setup` covers node deps, the Python deps in `agent/requirements.txt`,
`playwright install chromium`, and the schema. If you would rather do it by
hand:

```bash
npm install
python -m venv .venv && .venv/bin/pip install -r agent/requirements.txt
.venv/bin/python -m playwright install chromium
npx prisma db push
```

Then sign up. The first account on a fresh database becomes an admin.

**No LLM key is needed to see the product work.** Upload a resume and you get
the full readiness report immediately. Add any one of the four free-tier keys in
`.env` to enable rewrites and the written review.

`npm run preflight` reports exactly what this machine can and cannot do.

### Docker

```bash
cp .env.example .env      # fill POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, APP_DOMAIN
docker compose up -d
curl http://localhost:3000/api/health?deep=1
```

---

## Tests

```bash
npm test                                        # 63 tests — routes, money, quota, crypto
.venv/bin/python -m pytest agent                # 61 tests — the scorer and the pipeline
.venv/bin/python -m pytest agent -m "not slow"  # skip the Chromium renders
```

The Python suite is the one that matters. `test_readiness.py` pins the two
properties everything rests on — the score is deterministic, and a worse resume
scores lower. `test_variants.py` runs the real pipeline with the model stubbed,
because the anti-fabrication gates can only be proven by handing them a rewrite
that lies, and a real model mostly behaves.

Two tests in particular exist because the thing they check was once broken:
`test_the_gates_hold_against_a_deliberate_fabrication_attack` replays a rewrite
that added seven technologies the candidate had never touched and walked through
all three gates untouched, and
`test_right_aligned_dates_are_not_mistaken_for_two_columns` uses a fixture large
enough to actually exercise the detector — the original was below the evidence
floor and would have passed with the detector disabled.

---

## Pricing

Not a subscription. A placement season is six to ten weeks; charging monthly for
a product someone needs once earns most of its revenue from people forgetting to
cancel.

| | |
|---|---|
| Free | Full report, 2 resumes, 1 company target, no watermark |
| Season Pass — ₹399 | 90 days, everything, one payment, no auto-renew |
| Single pack — ₹99 | Three tailored rebuilds for one company |

Comparable tools charge $29–50/month (₹2,500–4,100), which is not a real price
for the market this is built for. Payments run in stub mode until
`PAYMENTS_ENABLED=true` and both Razorpay keys are set.

---

## Security

- Sessions: HMAC-SHA256 signed cookies, httpOnly, `secure` in production,
  `sameSite=lax`, revocable via a per-user token version.
- Passwords: scrypt (N=32768), constant-time verify, and an unknown email still
  pays for a verify so response time does not disclose whether an account exists.
- Rate limits: DB-backed, per IP and per account, atomic increment.
- OAuth: state in an httpOnly cookie, timing-safe compare, checked before the
  rate limiter so a forged callback cannot spend an honest campus IP's budget.
- Payments: the product and price are read off the order row, never the request;
  signature verified constant-time; confirmation idempotent.
- Uploads: extension and size checked, stored outside the web root, served only
  through an ownership-checked route.
- PII: emails, phones and long ID runs are stripped before any prompt leaves the
  server (`agent/redact.py`).
- Rendering: Chromium runs with JavaScript disabled and `offline: true`; all
  resume text is HTML-escaped through one total function.

## Limits worth stating

- Company packs are curated by hand and carry the date each was last checked.
  A company that reorganises its careers site will make a pack stale before we
  notice.
- The readiness score measures machine-recoverability and evidence density. It
  does not predict whether you will be hired, and nothing in the product claims
  it does.
- Two-column detection is a heuristic over extracted text. It is tuned to avoid
  false positives — a single-column resume with right-aligned dates must never
  be told to rebuild — which means it will miss some genuine two-column layouts.
