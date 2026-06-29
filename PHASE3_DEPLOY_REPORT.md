# Phase 3 — Deployment Readiness Report

**Date:** 2026-06-28
**Goal:** website live on a VPS, real users sign in with Google → onboarding → dashboard → agent.
**Verdict (original):** NOT deploy-ready — 5 blockers + 3 agent-feature gaps.

## ✅ Resolved (repo side, 2026-06-28)
All repo-fixable items done + verified (lint/tsc/vitest 12 · pytest 14 · build OK · `docker compose config` valid):
- **B1** web env (Google creds, `NEXT_PUBLIC_APP_URL`, admin, LLM) — added to `docker-compose.yml`.
- **B2** TLS — `caddy` service (auto Let's Encrypt) + `Caddyfile`; web no longer exposed on the host.
- **B3** schema — one-shot `migrate` service runs `prisma db push` + seeds admin before web/worker start.
- **C1** Python decoupled — `agent/run` + `resume` now **enqueue** to the DB queue (worker drains via `run_job` dispatcher); web spawn is best-effort, never 500s without Python.
- **C3** worker env — `INTERNPILOT_HEADLESS=1` + LLM keys added.
- **C2 / gmail-scan** — headed-browser connect + Gmail scan return a clear 503 in production (can't run server-side) instead of a broken 500; mock runs unaffected.
- **E** — `restart: unless-stopped` on all services + web `/api/health` healthcheck.

**Still yours (infra, can't be coded):** B4 secrets · B5 Google redirect URI · VPS · domain · DNS (see §H).
**Deferred (design, Phase 4):** C2 full live platform-connect needs a remote-browser flow; gated off for now.

The sections below are the original findings (kept for traceability).

---

**Verdict (original detail):** Stack builds, but 5 blockers stop a clean prod boot, and 3 agent features need an architecture decision for a server (vs local) environment.

Severity: 🔴 blocks website-live · 🟠 blocks agent-works · 🟡 polish.

---

## A. Readiness scorecard

| Area | State |
|---|---|
| Web image builds (`Dockerfile`) | ✅ |
| Worker image builds (`Dockerfile.worker`) | ✅ (hardened) |
| Postgres + shared volume in compose | ✅ |
| Prisma schema valid for Postgres | ✅ |
| Google-only login code | ✅ (hardened: state + email_verified) |
| **Compose passes Google creds + base URL to web** | 🔴 **missing** |
| **TLS / reverse proxy** | 🔴 **missing** (web exposed raw on :3000) |
| **DB schema creation on first boot** | 🔴 **not automated** |
| **Restart policies** | 🟡 missing |
| **Web image has Python** (spawn paths) | 🟠 **missing** |
| Worker gets LLM key + headless flag | 🟠 missing |
| Headed-browser platform-connect on a server | 🟠 **architecturally broken** |

---

## B. 🔴 Blockers to website-live (Google login + dashboard)

### B1. compose `web` is missing Google OAuth + base URL env
`docker-compose.yml` `web.environment` has only DATABASE_URL, APP_ENCRYPTION_KEY, REDIS_URL, NODE_ENV.
Google is the **only** login → without these the login button 503s and OAuth redirect is wrong.

**Fix — add to `web.environment`:**
```yaml
      GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
      GOOGLE_CLIENT_SECRET: ${GOOGLE_CLIENT_SECRET}
      NEXT_PUBLIC_APP_URL: ${NEXT_PUBLIC_APP_URL}   # https://your.domain
      ADMIN_EMAIL: ${ADMIN_EMAIL}
      GROQ_API_KEY: ${GROQ_API_KEY}
```
(`NEXT_PUBLIC_APP_URL` is read server-side in `baseUrl.ts`, so runtime env is fine.)

### B2. No TLS / reverse proxy
compose publishes `web` on `3000` with no HTTPS. OAuth + cookies (`secure: true` in prod) require HTTPS.

**Fix — add a Caddy service (auto Let's Encrypt), drop web's public port:**
```yaml
  caddy:
    image: caddy:2-alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddydata:/data
    depends_on: [web]
    restart: unless-stopped
```
Remove `ports: ["3000:3000"]` from `web` (Caddy reaches it over the internal network).
Add `caddydata:` to the `volumes:` block. `Caddyfile`:
```
your.domain {
  reverse_proxy web:3000
}
```

### B3. DB schema is never created
web `CMD` is `npm start` — nothing runs `prisma db push`/`migrate`. First boot → tables don't exist → every query 500s.

**Fix — run once after `up`:**
```bash
docker compose run --rm web npx prisma db push
```
(or bake `npx prisma migrate deploy` into an entrypoint once you add a migration). **This is the first time the Postgres path runs for real** — see §D.

### B4. Generate prod secrets (don't reuse dev)
Server `.env` must define: `POSTGRES_PASSWORD`, fresh `APP_ENCRYPTION_KEY` (64 hex), `NEXT_PUBLIC_APP_URL`, `GOOGLE_CLIENT_ID/SECRET`, `ADMIN_EMAIL`, `GROQ_API_KEY`.
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # APP_ENCRYPTION_KEY
```

### B5. Google Cloud redirect URI (infra)
Add to the OAuth client → Authorized redirect URIs:
```
https://your.domain/api/auth/google/callback
```
Only localhost is registered today → prod login fails until added.

---

## C. 🟠 Blockers to agent-works-in-prod

### C1. Web image has no Python — spawn paths fail
`Dockerfile` (web) is `node:20-slim`, no Python. These web routes shell out to Python:
- `api/agent/run` → spawns `worker.py --drain` → returns 500 (job IS enqueued, worker still runs it — confusing UX).
- `api/resume` → spawns `worker.py --analyze` → silently skipped → **resume scoring never runs**.
- `api/gmail/scan` → `execFileSync(python ...)` → 500.
- `api/integrations/connect` → spawns `connect_platform.py` → 500.

**Fix options:**
- (a) Make `agent/run` rely on the worker fleet (drop the web-side spawn) and **enqueue** resume-analyze + gmail-scan as queue jobs the worker drains. *Cleaner — recommended.*
- (b) Add Python+Playwright to the web image. *Fatter image, simpler code.*

### C2. Platform-connect opens a HEADED browser — impossible on a server
`integrations/connect` launches a visible browser for the user to log into LinkedIn/Internshala. On a headless VPS there's no display and the user can't see the server's browser. This was designed for local runs.
**Decision needed (Phase 4):** remote-browser session (e.g. noVNC/browserless) or a guided credential-capture flow. Not solvable by config.

### C3. Worker missing LLM key + headless flag
`worker.environment` lacks the LLM key (agent falls back to weak heuristic) and `INTERNPILOT_HEADLESS` (defaults to 0 = visible → crashes with no display).

**Fix — add to `worker.environment`:**
```yaml
      GROQ_API_KEY: ${GROQ_API_KEY}
      GEMINI_API_KEY: ${GEMINI_API_KEY}
      INTERNPILOT_HEADLESS: "1"
```

---

## D. 🟠 First-Postgres-run risk
The agent's Postgres path (`agent/db.py` + `run_queue.py`: `FOR UPDATE SKIP LOCKED`, naive-UTC datetimes, bool params, `ON CONFLICT`) is **compile-clean and SQLite-smoke-tested but has never hit a real Postgres** (no DB creds in the build env). §B3's `db push` + the first `mock` agent run is its live test. **Watch `docker compose logs worker`** on the first run.

---

## E. 🟡 Polish
- Add `restart: unless-stopped` to `postgres`, `redis`, `web`, `worker`.
- `web` has no healthcheck (postgres does) — add one hitting `/api/health` so deploys gate on readiness.
- Redis is provisioned but unused (queue is DB-backed) — harmless; keep for later.

---

## F. Deploy runbook (after fixes)
```bash
# on the VPS
git clone <repo> && cd NexPath
cp .env.example .env && nano .env            # fill §B4 values
docker compose build
docker compose up -d postgres                # wait healthy
docker compose run --rm web npx prisma db push   # create schema (§B3)
docker compose run --rm web node scripts/seed-admin.mjs   # seed admin
docker compose up -d                         # web + worker×2 + redis + caddy
docker compose logs -f web worker            # watch first boot
```

## G. Smoke test (go/no-go)
```bash
curl https://your.domain/api/health    # → { ok:true, prodReady:true, missing:[] }
```
Then in a browser: Google login → onboarding → dashboard → run agent (mock) → check `logs worker`.

## H. Infra checklist (yours)
- [ ] VPS, Ubuntu, ≥2 GB RAM, Docker + compose
- [ ] Domain + DNS A record → VPS IP
- [ ] Google Cloud redirect URI (§B5)
- [ ] Prod secrets generated (§B4)

---

## Priority to fix
1. **B1–B5** → website live, users sign in. (config + infra, ~2–3 h)
2. **C1, C3** → agent runs real jobs in prod. (code, ~half day)
3. **C2** → platform-connect on server. (design, Phase 4)

B1, B3, C1, C3, E are **repo changes I can make** when you're ready. B2/B4/B5/H are yours (server/accounts/secrets).
