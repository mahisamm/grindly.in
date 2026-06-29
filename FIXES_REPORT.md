# Grindly — Risk Remediation Report

> **Phase 2 (this pass): the previously-deferred infra items are now implemented**
> as real, build/test-verified code behind env seams + infra-as-code. See
> "Phase 2 — infra hardening" near the bottom. Verification: `npm run build` ✓,
> `npm test` ✓ 9/9, `pytest` ✓ 14/14, cross-language crypto interop ✓,
> `docker compose config` ✓, all routes 200.

---


Prototype hardening pass. Addresses the 🔴 (do-now) and 🟡 (next) items from the
risk inventory, including the two user-raised issues:

1. **Session timeout mid-apply** → failure taxonomy + session detection + urgent reconnect notify.
2. **Which resume did the recruiter see?** → immutable per-application resume snapshot + call-prep UI.

Verification: `npm run build` ✓ (TypeScript clean, 29 routes), `npm test` ✓ (6/6 firewall),
`python -c "import worker, safety, db, resume_ai, matcher"` ✓, all routes HTTP 200.

---

## Fixed

### 1. Resume versioning (user issue #2) — 🔴
- **`ResumeVersion` table** (Prisma) — immutable snapshot of the exact resume text + PDF path sent per application, with `skillsClaimed` (surfaced for that role) and `baseSkills` (master set at the time).
- **`Application.resumeVersionId`** links each application to the exact resume sent.
- **Worker** creates a snapshot in `_get_resume()` right before each apply and links it.
- **Call-prep UI** — `/applications` page: open any application → see status, reason, "what you presented", and **Download exact resume sent** (`GET /api/applications/[id]/resume`, owner-only, path-traversal guarded). Linked from dashboard header ("Call prep ↗").
- **Truthfulness guard** — `resume_ai._constrain_skills()` strips any skill from a "Skills:" line that the master resume can't support; tailor prompt now forbids inventing skills. Snapshot records claimed-vs-base so discrepancies are visible.

### 2. Apply integrity + session death (user issue #1) — 🔴
- **Failure taxonomy** — `src/lib/applyState.ts` + `agent/safety.py`: `session_expired | selector_missing | captcha | listing_closed | upload_failed | firewall_blocked | custom_questions | timeout | exception`. Stored in `Application.failureReason`; `humanFailure()` renders it ("3 skipped: listings closed").
- **Session detection** — `safety.session_ok(page)` / `detect_challenge(page)` for adapters to call before touching a form; login-required → integration set `needs_login`, application kept as `matched` (not falsely `applied`), `session_expired` recorded.
- **Urgent notify** — when a session dies mid-run the worker sends an immediate "Action needed — reconnect" Slack ping (separate from the daily digest).
- **Unconfirmed-state rule** — `isUnconfirmed()` marks timeout/session-death so such rows are never reported as applied.

### 3. Firewall hard-gate — 🔴
- **`src/lib/firewall.ts` `canApply()`** — pure, unit-tested (6 tests): excluded company (fuzzy), work-mode, stipend floor, min score. Mirrors `agent/matcher.firewall_block` + `safety.can_apply`.

### 4. Security — 🔴
- **OTP throttle** (`src/lib/otp.ts`) — 60s cooldown + 5/day per phone → kills SMS-pump/bill-blowup. All three issuing routes (register/login/send-otp) return **429** on throttle.
- **SMS hardening** (`adapters/sms.ts`) — missing Twilio creds in **production** now throws instead of silently "sending" the OTP to console (closes a verify-bypass).
- **Audit trail** (`AuditLog` + `src/lib/audit.ts`, `db.add_audit`) — login, login_fail, otp_issued/throttled/verify_fail, consent, run_start, apply, apply_failed, session_expired, notify_urgent. Append-only, best-effort (never blocks the action).
- **Consent record** — `Profile.autoApplyConsentAt` stamped when the user enables auto-apply (`/api/profile`); worker warns + audits if auto-apply runs without it.

### 5. Notifications — 🔴
- **Tiered `src/lib/notify.ts`** — `urgent` (Slack **and** email) vs `digest` (Slack, email fallback). Every send recorded in `Notification` table with `delivered`. **Email fallback adapter** (`adapters/email.ts`, dev outbox; SMTP = deferred).

### 6. Quota — 🔴 / Phone — 🟡 / Observability — 🔴/🟡
- **`src/lib/quota.ts`** — server-side `remainingToday()` (pro 30 / starter 10 / free 0); never trusts the client.
- **Phone** — `libphonenumber-js` E.164 normalization + `isValidPhone()` (register rejects bad numbers); old heuristic kept as fallback.
- **Observability** — failure taxonomy + audit log + screenshot helper (`safety.screenshot()` saves proof PNGs per attempt; wired into `Application.screenshotPath`).

---

## Deferred — needs infrastructure / accounts (not codeable in the prototype env)

These are designed-for but require services this environment can't stand up. Code is structured so each drops in behind an existing seam.

| Item | Why deferred | Drop-in point |
|---|---|---|
| **SQLite → Postgres** | Needs a Postgres server. Concurrent Python+Next writes will contend at scale. | `datasource` URL + `prisma migrate`; Python switches to `psycopg`. db.py already uses `busy_timeout` to survive prototype concurrency. |
| **Redis + job queue (BullMQ/Celery)** | Needs Redis. Replaces single-worker sequential runs; per-user lock, retries, idempotent resume. | `worker.run_for_user` is already a single idempotent unit to enqueue. |
| **Containerized browser fleet** | Needs Docker/orchestration. Fixes scale + zombie-chrome leaks. | Per-platform adapters already isolate browser contexts (`mod.close(uid)`). |
| **Real payments (Razorpay/Stripe)** | Needs merchant account + webhook endpoint. | `adapters/payment.ts` stub; quota.ts enforces caps regardless. |
| **CAPTCHA solving** | Needs a paid vendor + ToS-legal review. | `safety.detect_challenge()` flags it today → route to human handoff. |
| **Email SMTP** | Needs provider creds. | `adapters/email.ts` — swap stub for nodemailer/Resend/SES, same signature. |
| **Encrypted session/credential storage** | Needs KMS/secret backend. | Prefer storing session cookies over passwords; envelope-encrypt before persisting. |
| **Test runner in CI** | vitest installed + `npm test` wired; CI pipeline itself is infra. | `.github/workflows` + `npm test` / `pytest`. |

## The one decision that reshapes everything — legal/ToS model
Auto-applying on LinkedIn/Naukri/Indeed violates their ToS (ban + legal risk). **Decide before scaling**: (a) **assisted-apply** — agent prepares + fills, user clicks final Submit (sidesteps most bans, strengthens consent); (b) official/partner APIs; (c) accept the risk explicitly. Current code supports (a) cleanly via `auto_apply=false` → `matched`/`approved` flow.

---

---

## Phase 2 — infra hardening (previously "deferred")

All implemented as real code + IaC. Live execution of the external services
(Postgres/Redis servers, Docker daemon, Stripe/SMTP accounts) is the only thing
left to *operate* — the code paths are written and verified.

### DB-backed run queue — replaces Redis for the prototype ✅ (infra-free)
- `AgentRun` table + `agent/queue.py`: `enqueue` (idempotent — one queued/running job per user), `claim_next` (transactional `BEGIN IMMEDIATE`, skips users with a running job → no double-apply), `mark_done`/`mark_failed` (retry w/ `maxAttempts`, then fail), `reclaim_stale` (crash recovery — requeues jobs locked > 30 min), `drain`/`serve`.
- `worker.py --drain` / `--serve`; `/api/agent/run` now enqueues then drains.
- **Gives:** retries, per-user locking, idempotent resume, crash recovery — the things Redis was wanted for — with zero new infra. Maps cleanly to `SELECT … FOR UPDATE SKIP LOCKED` on Postgres later.

### Encrypted credential vault ✅ (infra-free)
- `src/lib/crypto.ts` + `agent/secret_box.py`: AES-256-GCM, wire format `base64(nonce).base64(ct‖tag)`, **byte-compatible across TS↔Python** (verified: Node decrypted Python's ciphertext). Key from `APP_ENCRYPTION_KEY`.
- `PlatformCredential` table stores ciphertext only — never plaintext passwords/sessions.

### Email SMTP ✅
- `adapters/email.ts` now sends via **nodemailer** when `EMAIL_SMTP_*` set; dev falls back to outbox. Tiered `notify.ts` already uses it for urgent/fallback.

### Payment webhook ✅
- `/api/pay/webhook` verifies the Stripe `Stripe-Signature` HMAC (timing-safe) before marking a user paid — a forged POST can't flip `paid`. `payment.ts` passes `metadata[plan]`.

### Tests + CI ✅ (runs green now)
- vitest: firewall (6) + crypto (3) = **9 passing**. pytest: matcher (5) + safety (6) + secret_box (3) = **14 passing**.
- `.github/workflows/ci.yml`: web job (npm ci → prisma generate → db push → build → test) + agent job (pip → pytest).

### Postgres + Docker (IaC ready; needs the daemon/servers to *run*)
- `datasource.url` now `env("DATABASE_URL")` (+ `.env`/`.env.local`) — config out of code; local stays sqlite.
- `Dockerfile` (web, multi-stage), `Dockerfile.worker` (Playwright+Python), `docker-compose.yml` (postgres + redis + web + **worker replicas: 2** fleet), `.dockerignore`. **`docker compose config` validates ✓.**
- `prisma/MIGRATE_POSTGRES.md` — exact provider/URL/migrate steps + psycopg note for the Python side.

### Still genuinely external (cannot run here; code/config ready)
- Live Postgres/Redis migration run · building/running the Docker images · real Stripe/SMTP/CAPTCHA **accounts**. Each has its seam wired; flip the env + run the service.
- **CAPTCHA**: `safety.detect_challenge()` flags it → routed to human handoff (no auto-solve without a ToS-legal vendor).
- **The ToS/auto-apply legal decision** remains a business call, not code.

---

## Files changed
### Phase 2
**Schema:** `AgentRun`, `PlatformCredential`, `datasource url=env(DATABASE_URL)`
**TS:** `crypto.ts`(+test), `adapters/email.ts`(nodemailer), `adapters/payment.ts`, `api/pay/webhook`, `api/agent/run`(enqueue)
**Python:** `queue.py`(new), `secret_box.py`(new), `worker.py`(--drain/--serve), `conftest.py`, `tests/`(matcher/safety/secret_box)
**Infra:** `Dockerfile`, `Dockerfile.worker`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/ci.yml`, `prisma/MIGRATE_POSTGRES.md`, `.env`, `.env.local`, `requirements.txt`(+cryptography)

### Phase 1
**Schema:** `prisma/schema.prisma` (ResumeVersion, AuditLog, Notification, Application+3, Profile+consent)
**TS libs:** `applyState.ts`, `firewall.ts`(+`.test.ts`), `quota.ts`, `audit.ts`, `notify.ts`, `otp.ts`, `adapters/sms.ts`, `adapters/email.ts`
**Routes:** `api/applications`, `api/applications/[id]/resume`, `api/login`, `api/register`, `api/profile`, `api/auth/send-otp`
**UI:** `app/applications/page.tsx`, dashboard header link
**Agent:** `safety.py`(new), `resume_ai.py`(truthfulness), `db.py`(snapshot/audit/columns), `worker.py`(wiring)
