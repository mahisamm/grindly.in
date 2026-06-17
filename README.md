# NexPath

Your AI applies to internships while you sleep. A local-first SaaS: users sign up,
upload a resume, answer a few **proff questions** (which become the agent's
firewall), pay, connect Slack — then an agent reads the resume, finds matching
internships, **auto-applies** within the limits, and sends a **daily Slack report**.

Built around **Internshala**. Payment + Slack run in **stub mode** locally (no keys
needed) and flip to real Stripe/Slack by setting two env vars. Resume analysis +
match scoring run on a **local Ollama model** — free and private.

---

## Architecture

```
nexpath/
├─ src/app/                 Next.js (App Router, TS, Tailwind v4)
│  ├─ page.tsx              Landing page
│  ├─ signup/               Account creation
│  ├─ onboarding/           Resume → proff questions → Slack → payment
│  ├─ dashboard/            Live applications, reports, run trigger
│  └─ api/                  register · profile · resume · pay · slack · agent/run · me
├─ src/lib/
│  ├─ prisma.ts             DB client (SQLite)
│  ├─ proffQuestions.ts     The onboarding questions (→ firewall constraints)
│  └─ adapters/             slack.ts + payment.ts  (stub ⇄ real, same signatures)
├─ prisma/schema.prisma     User · Profile · Job · Application · Report
└─ agent/                   Python worker (the actual brain)
   ├─ worker.py             Orchestrates one run: parse→plan→match→apply→report→notify
   ├─ resume_parse.py       PDF/DOCX/TXT extract + LLM skill extraction
   ├─ matcher.py            Resume↔role score (0–100) + firewall enforcement
   ├─ mockboard.py          Mock listings (mode=mock, safe demo)
   ├─ internshala.py        Live Playwright scrape + apply (mode=live)
   ├─ notify.py             Slack adapter (mirrors web stub outbox)
   ├─ llm.py                Local Ollama REST client
   └─ db.py                 Shared SQLite access (Prisma-compatible writes)
```

The web app and the Python agent share **one SQLite DB** (`prisma/dev.db`). The web
owns the schema; the agent writes Prisma-compatible rows (epoch-ms dates, 0/1 bools)
so the dashboard sees results live.

## How it flows

1. **Sign up** → cookie session created.
2. **Onboarding** → upload resume, answer proff questions (domains, locations,
   stipend floor, **min match score**, **max/day**, excluded companies, auto-apply),
   connect Slack, pick a plan, pay.
3. **Payment confirm** → user marked `active`, Slack onboarding DM fired.
4. **Agent run** (dashboard button, or scheduled) → `agent/worker.py`:
   - extracts skills from the resume (local LLM),
   - builds a plan from the firewall constraints,
   - fetches listings (mock or live Internshala),
   - scores each, drops anything the firewall forbids or below your threshold,
   - auto-applies to the strong matches up to your daily cap,
   - writes a daily report and sends it to Slack.
5. **Dashboard** polls every 4s — applications + reports appear in real time.

---

## Run it locally

Prereqs: Node 18+, Python 3.10+, [Ollama](https://ollama.com) running with
`qwen3:4b-instruct` pulled.

```bash
# 1. Web deps + DB
npm install
npx prisma db push        # creates prisma/dev.db

# 2. Agent deps
pip install -r agent/requirements.txt
# live mode only (real Internshala):
python -m playwright install chromium

# 3. Start the web app
npm run dev               # http://localhost:3000
```

Open the site → sign up → onboard → pay (stub) → on the dashboard hit
**Run agent now (demo)**. Applications stream in.

### Demo vs live
- **Run agent now (demo)** → `mode=mock`: fake board, full pipeline, no external site.
- **Run live** → `mode=live`: drives real Internshala. Requires logging into
  Internshala **once** in the agent's browser (`agent/browser_profile/` persists the
  session). Without login it shortlists and reports `login_required` instead of
  faking an application.

### Scheduled service mode
Run the agent as a daemon that sweeps all active users every 24h:
```bash
python agent/worker.py --loop --mode mock      # or --mode live
```

### Going real (optional)
Set in `.env.local` — nothing else changes:
- `STRIPE_SECRET_KEY` → real Stripe Checkout
- `SLACK_BOT_TOKEN` → real Slack DMs

In stub mode, "sent" Slack messages are appended to `data/slack-outbox.jsonl` so you
can see exactly what the bot would post.

---

### One-command start (Windows)
```bash
start.bat      # ensures Ollama, starts the daily scheduler + web app
```

### Auth
Real email + password (scrypt-hashed, no external dep). Sign up at `/signup`, log
back in at `/login`, log out from the dashboard. Sessions are httpOnly cookies.

### Connect Internshala (live mode)
On the dashboard, **Connect Internshala** opens a real browser — log in once and the
session persists in `agent/browser_profile/`. After that, **Run live** applies for
real. Demo mode needs none of this.

### Pause / resume
Pause from the dashboard anytime — the scheduler (`worker.py --loop`) skips paused
users (it only sweeps `paid` + `status='active'`).

---

## Notes & limits
- Live Internshala scraping/applying is best-effort — site DOM shifts and anti-bot
  measures can break it; the firewall + daily cap keep it polite.
- The match score **is** the firewall: raise `min match score` to be pickier.
- Payment + Slack are stubbed locally; set `STRIPE_SECRET_KEY` / `SLACK_BOT_TOKEN`
  to go real (no code change).
