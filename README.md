# Grindly

Your AI finds and submits safe internship applications while you sleep, and
prepares the rest for one final user review. A
local-first SaaS: users sign up, upload a resume, answer a few **proff questions**
(which become the agent's firewall), start a trial, connect a platform — then an
agent reads the resume, finds matching internships, applies through supported
employer-owned intake forms (and explicitly consented staged platforms), and sends
a **daily report**. Account-sensitive boards stay in Safe Apply Mode, where Grindly
prepares the application and the user performs the final submit.

Supported integrations are **LinkedIn, Internshala, Naukri, Unstop, and Indeed**.
External and unsupported complex application flows are skipped. Payment + Slack run in **stub mode**
locally (no keys needed) and flip to real Razorpay/Slack by setting env vars.
Resume analysis + match scoring can use a **fusion LLM ensemble** (Groq,
Gemini, Cerebras, Mistral), with local Ollama as fallback. When external AI
providers are configured, relevant resume and job text is sent to them as
described in the Privacy Policy.

---

## Architecture

```
Browser ─── Caddy (TLS) ─── Next.js 16 (web)
                                │
                    ┌───────────┼────────────┐
                    │           │            │
              REST API      Postgres     Redis (queue)
              (auth/pay/     (schema)
               profile)         │
                             Worker
                            (Python)
                                │
              ┌─────────────────┼────────────────┐
              │                 │                │
           LinkedIn          Naukri           Indeed
         Internshala         Unstop          (Playwright)
```

```
Grindly/
├─ src/app/                 Next.js App Router (TS, Tailwind v4)
│  ├─ page.tsx              Landing page
│  ├─ signup/               Redirects to Google-only login
│  ├─ login/                Google OAuth
│  ├─ onboarding/           Resume → profile questions → notifications → activation
│  ├─ dashboard/            Live applications, reports, run trigger
│  ├─ applications/         Application history + resume download
│  └─ api/                  auth/google · profile · resume · pay · slack · agent/run · me
├─ src/lib/
│  ├─ prisma.ts             DB client (Postgres)
│  ├─ otp.ts                OTP issue + verify + brute-force guard
│  ├─ rateLimit.ts          DB-backed rate limiter
│  ├─ firewall.ts           Hard-gate apply rules (unit-tested)
│  ├─ session.ts            HMAC-signed cookie sessions
│  └─ adapters/             slack · payment · sms · email (stub ⇄ real)
├─ prisma/schema.prisma     24 models (User · Profile · Application · AgentRun · ...)
└─ agent/                   Python worker (the actual brain)
   ├─ worker.py             Orchestrates: parse → plan → match → apply → report → notify
   ├─ run_queue.py          DB-backed job queue (transactional, stale-lock recovery)
   ├─ resume_parse.py       PDF/DOCX/TXT extract + LLM skill extraction
   ├─ matcher.py            Resume↔role score (0–100) + firewall enforcement
   ├─ linkedin.py           LinkedIn Easy Apply (Playwright, stealth headers)
   ├─ naukri.py             Naukri scrape + apply
   ├─ indeed.py             Indeed scrape + apply
   ├─ internshala.py        Internshala scrape + apply
   ├─ mockboard.py          Mock listings (mode=mock, safe demo)
   ├─ notify.py             Slack/email notifications
   ├─ llm.py                Fusion LLM ensemble (Groq/Gemini/Cerebras/Mistral/Ollama)
   ├─ safety.py             Firewall rules (Python mirror of src/lib/firewall.ts)
   └─ db.py                 Postgres/SQLite dual-backend (Prisma-compatible writes)
```

---

## How it flows

1. **Sign up** → Google OAuth → signed httpOnly cookie session.
2. **Onboarding** → upload resume → profile questions (domains, locations, stipend floor,
   min match score, max/day, excluded companies, auto-apply) → pick email/Slack reports → activate (free during beta).
3. **Activation** → user marked `active`, onboarding report/DM fired.
4. **Agent run** (dashboard button or scheduled) → `agent/worker.py`:
   - Parses resume → extracts skills (LLM ensemble).
   - Builds a plan from firewall constraints.
   - Fetches listings from public search / guest APIs across the 5 boards in parallel.
   - Scores each job, drops anything the firewall forbids or below your threshold.
   - Submits eligible matches through policy-approved employer intake channels, up to the daily cap.
   - Prepares account-sensitive board applications (tailored resume + cover letter + answers) for the user's final browser submit.
   - Writes a daily report + sends it to email/Slack.
5. **Dashboard** polls every 12s — matches + reports appear in near real time.

---

## Run it locally

**Prerequisites:** Node 18+, Python 3.10+, Postgres (or Docker).

```bash
# 1. Web deps + DB schema
npm install
npx prisma db push        # applies schema to Postgres

# 2. Agent deps
pip install -r agent/requirements.txt
python -m playwright install chromium   # live mode only

# 3. Configure
cp .env.example .env
npm run setup             # generates APP_ENCRYPTION_KEY

# 4. Start
npm run dev               # http://localhost:3000
```

Open the site → sign up → onboard → activate the free beta → on the dashboard
hit **Run agent**. Real matches stream in; eligible safe destinations are submitted.

### Docker (production-like)

```bash
cp .env.example .env
# fill in POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, GOOGLE_CLIENT_ID/SECRET, ADMIN_EMAIL
docker compose up -d
# verify
curl http://localhost/api/health
```

The compose stack starts: Postgres → migrate (schema + seed) → web + 2 workers + Caddy + daily backup.

---

## Live agent

The product has no mock/demo path. **Run agent** discovers real public listings.
Employer-owned destinations can be submitted without a board login. Internshala
submission requires the user to connect and consent once; account-sensitive boards
remain prepared for the user's final browser submit.

### Scheduled service mode

```bash
python agent/worker.py --serve    # drains queued work in a 10s loop
python agent/sweep.py --serve     # schedules one live run per active user each day
```

On Windows, `start.bat` starts both of these services and the web app. An
active user with a completed profile is then discovered, scored, queued, and
processed automatically according to their plan and auto-apply preferences.

---

## Going real (optional)

Set in `.env` — nothing else changes:

```env
RAZORPAY_KEY_ID=rzp_live_...     # real Razorpay Checkout (unset = free stub)
RAZORPAY_KEY_SECRET=...          # server-only: signs orders + verifies payments
SLACK_BOT_TOKEN=xoxb-...         # real Slack DMs
TRUST_PROXY=1                    # when behind Caddy/Nginx
GRINDLY_SPREAD_APPLIES=1         # human pacing (5-15 min between applies)
GRINDLY_AUTO_APPLY_MODE=live     # send policy-approved Tier A destinations
GRINDLY_TIER_B_APPLY=1           # allow explicitly consented Tier B submissions
INTERNSHALA_BETA_OPEN=1          # open Internshala auto-apply to all users
```

---

## Auth

Google OAuth is the only user-facing sign-in method in the current beta. Sessions
are HMAC-signed httpOnly cookies; `APP_ENCRYPTION_KEY` protects stored platform
credentials. Legacy password and OTP helpers remain internal and are not exposed
as signup or password-reset flows.

---

## Connect a platform (live mode)

On the dashboard → **Integrations** → connect Internshala → log in once → the
encrypted credential/session persists on the shared app-data volume. After that,
**Run agent** may submit eligible Internshala applications under the staged policy.

---

## Pause / resume

Pause from the dashboard anytime — the scheduler skips paused users (only sweeps
`paid` + `status='active'`).

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| `GET /api/health` returns `prodReady: false` | Run `curl /api/health` — `missing` array lists what's absent |
| Agent job stuck | Check worker logs for `[nexpath.queue]` stale-lock messages; reclaim runs after 30 min automatically |
| Worker can't connect to DB | `DATABASE_URL` must point to Postgres; check `database` in health response |
| Playwright `browser not found` | Run `python -m playwright install chromium` |
| Platform login required | On dashboard → Integrations → reconnect the platform |
| High failure rate warning in logs | Platform selectors may have changed; check `HIGH FAILURE RATE` in worker logs |
| Docker `migrate` keeps restarting | `POSTGRES_PASSWORD` mismatch or Postgres not healthy yet — check `docker compose logs migrate` |

---

## Security

- Sessions: HMAC-SHA256 signed cookies, httpOnly, secure (prod), sameSite=lax.
- Platform credentials: AES-256-GCM encrypted at rest (`PlatformCredential` table).
- OTP: 6-digit, 10-min expiry, 5 attempts → 15-min lockout, 5/day/phone cap.
- Rate limits: DB-backed per-IP per action, atomic increment.
- CSRF: OAuth state in httpOnly cookie, timing-safe compare.
- CSP, HSTS, X-Frame-Options, Referrer-Policy all set in `next.config.ts`.

---

## Notes & limits

- Live platform scraping is best-effort — DOM shifts and anti-bot measures can break
  selectors; the firewall + daily cap keep the agent polite.
- Match score **is** the firewall: raise `min match score` to be pickier.
- Payment + Slack are stubbed locally; set `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET`
  / `SLACK_BOT_TOKEN` to go real (no code change).
- `GRINDLY_SPREAD_APPLIES=1` enables 5-15 min gaps between applies in production —
  strongly recommended to avoid bot-detection flags.
