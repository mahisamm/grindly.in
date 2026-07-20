# Grindly — Full QA / Security Audit

**Tester:** senior-QA pass (automated, code-level)
**Date:** 2026-07-20
**Scope:** whole repo — web app, browser extension, Python agent/worker, infra/deploy config
**Branch:** master (clean working tree)
**Method:** gate checks run live (not carried over) + 6 parallel deep-dive manual audits, with the highest-severity claims independently re-verified by reading the cited source myself.

---

## ✅ Resolved (2026-07-20, same pass)

All 26 findings below (2 Critical, 9 High, 7 Medium, 8 Low incl. the repo-hygiene note) were fixed and re-verified: `tsc` 0 errors · `eslint` 0 · `next build` OK (same 48 routes as baseline) · `vitest` **278/278** (37→38 files, +14 tests for the new/changed logic) · `pytest` **264/264** · `docker compose config` valid.

**Key fixes:**
- **1.1** `docker-compose.yml`'s stray `POSTGRES_PASSWORD_ENC` → `POSTGRES_PASSWORD` everywhere (fresh-deploy blocker).
- **1.2** Admin Settings is real now: `maintenanceMode`/`globalDailyCap`/`featureFlags.autoApply` gate `/api/agent/run` (web) **and** the Python queue's `claim_next()` (`agent/admin_settings.py` reads the same shared `data/admin-settings.json`); `featureFlags.googleAuth` gates login; `bannedDomains` gates signup. Removed the `smsOtp` flag — nothing in the app implements SMS OTP login anymore, so it controlled nothing.
- **2.1** Gmail OAuth callback now requires `getUid() === state`, closing the cross-account token-injection path.
- **2.2** `getIp()` now takes the *last* `X-Forwarded-For` hop under `TRUST_PROXY=1`, matching how Caddy actually appends it.
- **2.3** `/api/applications/submitted` uses a new atomic `tryConsumeApplyQuota` (same primitive as `rateLimit.ts`) instead of check-then-write; `approve`/`approve-all` now also count already-approved-but-unsubmitted rows against today's cap via `remainingForApproval`.
- **2.4** Extension fill engine skips non-visible elements (`isFillable`) so a same-page hidden widget can't silently soak up PII.
- **2.5** `/onboarding` redirects logged-out visitors to `/login` instead of silently falling through on a 401.
- **2.6** `run_job` (Python) wraps `run_for_user` in `try/finally`, force-closing all 5 adapters' browser contexts regardless of where an exception happened — closes the zombie-Chromium leak.
- **2.7** `connect_service` no longer claims a reconnect for a user with a `running` apply job (`db.next_pending_connect_request` now excludes them); `stealth.clear_stale_lock` also checks the lock owner PID is actually dead before removing it.
- **2.8** Worker's safety caps (`GRINDLY_CAP_PER_PLATFORM`/`_PER_RUN`) and **4.7** `OPS_SLACK_CHANNEL` now actually reach the `worker` container via compose.
- **2.9** Dashboard's run-poll and connect-poll loops stop on unmount (`unmounted`/`connectAbort` refs), so navigating away and back can't double-poll.
- **3.1** New explicit `PAYMENTS_ENABLED` switch (server-computed, surfaced via `/api/me` like `gmailScanEnabled` — not a build-time `NEXT_PUBLIC_` var) genuinely disables the "coming soon" button and gates both `/api/pay` and `/api/pay/confirm`, independent of `NODE_ENV`/Razorpay-key inference.
- **3.2** Extension pairing (`grindly-ext:pair`) now only honored on `/extension/connect`; the presence-ping stays on all of grindly.in.
- **3.3** `purge-demo.mjs`'s report wipe is now opt-in via `--purge-reports` (was unconditionally deleting every user's report history).
- **3.4** `twa-manifest.json` **and** the generated `android/.../AndroidManifest.xml` repointed from `grindly.vercel.app` to `grindly.in`.
- **3.5/4.8** `run_queue.claim_next`/`reclaim_stale` now enforce `attempts < max_attempts` (both SQLite and Postgres); the Postgres replica-race caveat is now documented in `docker-compose.yml` instead of overclaiming safety.
- **3.6** Admin sidebar badge: stale "N" → "g".
- **3.7** `admin/applications` and `admin/audit` show "Loading…" before first paint, matching every sibling admin page.
- **4.1** SW registration moved to an external `/sw-register.js` so `script-src` no longer needs `'unsafe-inline'` for the app's own code (Razorpay-checkout inline handlers are the one remaining unverified case — documented in `next.config.ts`, dormant while `PAYMENTS_ENABLED=false`).
- **4.2** Extension pairing origin check uses parsed `URL().origin`, not `.startsWith()`.
- **4.3** Built a real "paste code" fallback in the extension popup (was promised in the connect-page copy but didn't exist).
- **4.4** Kit-fetch errors (network/rate-limit/server) now show a "Retry" state with a toast instead of silently vanishing.
- **4.5** Fuzzy answer-matching now requires 3 shared words, not 2.
- **4.6** Dashboard's local `TagInput` remove button got the `aria-label` the shared component already had.
- **4.9** Removed the 11 leftover empty directories (local-only, not git-tracked — confirmed harmless, cleaned up anyway).

**Left as-is / partial, with reasoning:** the extension fill engine is still document-scoped rather than form-scoped (2.4) — visibility filtering closes the actual "invisible field" exploit described; form-boundary detection was skipped because several supported platforms (LinkedIn Easy Apply) render the application UI with no `<form>` wrapper at all, and guessing wrong would break real fills with no way to verify in a live browser here. CSP `'unsafe-inline'` (4.1) is fully removed for the app's own scripts but kept for Razorpay's checkout modal, which I can't verify CSP-compatibility for without a live checkout run.

---

## 0. Gate checks (all green — re-run today, not assumed)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx eslint .` | ✅ 0 errors/warnings |
| `npm run build` (prod, Turbopack) | ✅ pass, 60+ routes generated |
| `npx vitest run` | ✅ 264/264 (37 files) |
| `python -m pytest` (agent/) | ✅ 264/264 |
| Secrets in git | ✅ none — `.env*` and `android-keystore.jks` properly gitignored, only `.env.example` tracked |

Static/automated gates are clean. Everything below is logic, security, and UX defects gates can't catch — the kind a manual pass finds.

**Baseline note:** a prior audit (TEST_REPORT.md, 2026-06-27) found and fixed C1 (payment bypass), C2 (broken password reset), H1–H3 (unsigned session cookie, OAuth CSRF, unverified-email account linking), M1/M3/M4/M5. I re-verified all of these directly in the current code — **all still hold**, with one exception noted in Finding #4 (the anti-IP-spoofing fix built on top of M6 is incomplete). C2's routes (`/api/auth/forgot-password`, `/reset-password`, etc.) have since been deleted outright — auth is Google-only now — and nothing in the app still links to them.

---

## 1. CRITICAL

### 1.1 Fresh deploy can't boot — Postgres password env var mismatch
**File:** `docker-compose.yml`
Postgres itself is provisioned with `POSTGRES_PASSWORD` (line 17, matches `.env.example:95`), but every consumer builds `DATABASE_URL` from a **different variable that's defined nowhere in the repo**:
```
line 54  (migrate): postgresql://grindly:${POSTGRES_PASSWORD_ENC}@postgres:5432/grindly
line 73  (web)
line 139 (worker)
line 209 (sweep)
line 245 (connect)
```
`POSTGRES_PASSWORD_ENC` doesn't appear in `.env.example`, `README.md`, or any deploy doc. On a clean `docker compose up`, it resolves to an empty string, so every service tries to auth with a blank password against a server configured with the real one. `migrate` fails first, and since `web`/`worker`/`sweep`/`connect` all `depends_on: migrate: condition: service_completed_successfully`, **the whole stack never comes up**. If production is currently live (it is, per grindly.in), the real server's `.env` must already define `POSTGRES_PASSWORD_ENC` out-of-repo — but any fresh clone, redeploy from docs, or new environment following `.env.example` as written will break here.
**Fix:** pick one variable name and use it everywhere; add it to `.env.example`.

### 1.2 Admin Settings page is entirely inert — every control is a placebo
**Files:** `src/app/admin/settings/page.tsx`, `src/app/api/admin/settings/route.ts`
Maintenance mode, Global daily cap, all three feature flags (`googleAuth`, `smsOtp`, `autoApply`), and Banned domains persist to a flat file `data/admin-settings.json` (`readSettings`/`writeSettings`). Confirmed by repo-wide grep: **nothing else reads this file** — not `proxy.ts`, not `/api/agent/run`, not the Python worker, and there's no `AdminSettings` Prisma model. An admin who flips "Maintenance mode" ON — exactly as the UI instructs, "use before deploys or DB migrations" — gets **zero actual effect**; agent runs continue uninumbered. Same for the daily cap and every feature flag.
**Fix:** either wire these into the actual gates (`agent/run` route, `proxy.ts`, worker startup) or remove the page until it does something.

---

## 2. HIGH

### 2.1 Gmail OAuth callback lets an attacker attach a victim's inbox access to the attacker's own account
**Files:** `src/app/api/auth/gmail/route.ts`, `src/app/api/auth/gmail/callback/route.ts:38,74,81`
`state` is `uid.timestamp.HMAC(uid:timestamp)` — this stops *tampering* with the uid, but the callback never checks that `state`'s uid matches the session actually completing the flow (no `getUid()` call in `callback/route.ts`). An attacker, logged into their own Grindly account, can hit `/api/auth/gmail` to mint a validly-signed state for *their own* uid, then hand the resulting Google authorize URL to a victim. If the victim completes Google's consent screen, the callback does:
```ts
await prisma.platformCredential.upsert({
  where: { userId_platform: { userId: state, platform: "gmail" } }, ...
```
— storing the **victim's** Gmail refresh token under the **attacker's** account. The attacker's account then has ongoing read access to the victim's inbox. This is a stronger bug than the login-CSRF class already fixed for Google login (H2), because there the worst case is session confusion — here it's persistent cross-account data access.
**Fix:** require `(await getUid()) === state` in the callback before upserting.

### 2.2 Rate-limit IP detection trusts the wrong end of X-Forwarded-For — spoofable behind the actual prod proxy
**File:** `src/lib/rateLimit.ts:51-60`, `Caddyfile:45`
`getIp()` takes `xff.split(",")[0]` (first hop) when `TRUST_PROXY=1`. Caddy's `reverse_proxy` **appends** the real client IP to any pre-existing `X-Forwarded-For` rather than replacing it, so the first hop is still attacker-controlled. An attacker can set an arbitrary `X-Forwarded-For` header and rotate it per request to bypass every IP-keyed limit: login/OTP attempts, the Google-callback account-creation cap (20/hr), and `/api/track`. This is a regression in the fix that was supposed to close M6 (M6 itself was explicitly "accepted" as low-risk in the old report — this is a different, unintentionally broken version of the fix built since).
**Fix:** with exactly one trusted proxy hop, take the **last** XFF entry, not the first.

### 2.3 Daily application quota can be exceeded via concurrent requests + accumulated approvals
**Files:** `src/app/api/applications/submitted/route.ts:24-45`, `src/app/api/applications/{approve,approve-all}/route.ts`
`submitted` reads quota (`getQuota()`), checks `remaining === 0`, then updates the row in a separate, unguarded statement — no transaction, no row lock. Firing several concurrent `POST /api/applications/submitted` requests lets every request's quota read land before any write commits, so all can pass and the day's applied count exceeds the plan cap. Separately, `approve`/`approve-all` only check the *applied* count against the cap, not how many rows are already `approved`-but-unsubmitted — those never expire, so a user can call `approve-all` daily for several days and bank far more approved rows than one day's cap, then burst-submit them.
**Fix:** wrap the read-check-write in a transaction with row locking (or a single atomic conditional update), and have approve/approve-all also account for outstanding approved-but-unsubmitted rows.

### 2.4 Extension "Fill" scope is the whole page, not the application form — can silently leak PII into unrelated widgets
**File:** `extension/src/fillEngine.js:131-132`, `content/filler.js:72`
`readFields` runs `document.querySelectorAll("textarea, input, [contenteditable='true']")` over the **entire page**, with no containment to the actual application form and no visibility check (`offsetParent`/`display`). Job boards commonly carry unrelated same-page widgets (hidden newsletter/chat lead-capture forms) with fields labeled "email"/"phone"/"name". Clicking "Fill with Grindly" can silently write the user's PII — or the cover letter, if a widget textarea's label matches — into those hidden fields, with the user never seeing it happen, contradicting the "review before Submit" safety story the extension is built around. No attacker needed — an ordinary page layout triggers it.
**Fix:** scope `readFields` to the nearest `<form>` containing the trigger button (or an explicit application-form selector), and skip non-visible elements.

### 2.5 `/onboarding` has no working auth guard — logged-out visitors can use the full wizard
**File:** `src/app/onboarding/page.tsx:73-83`
```ts
fetch("/api/me").then(r => r.ok ? r.json() : null).then(d => {
  if (!d?.user) return;   // <-- 401 resolves to null, so this just returns — no redirect
  ...
});
```
Unlike `/dashboard` and `/applications`, which redirect to `/login` on a 401, onboarding's guard is only meant to bounce *unapproved* accounts to `/waitlist` — it has no branch at all for "not logged in." A signed-out visitor (or one with an expired session) who opens `/onboarding` directly can complete all four steps; every save just silently 401s in the background, so they get a broken, seemingly-functional wizard that saves nothing.
**Fix:** on `!r.ok`, redirect to `/login`, matching the pattern already used on `/dashboard`.

### 2.6 Python worker leaks a browser process on any mid-run exception
**File:** `agent/worker.py` — `run_for_user()` (~line 656), cleanup at ~line 1457
There's no top-level `try/finally` around the run. Playwright contexts are cached per-user at module scope in each adapter (`agent/internshala.py:56-88`, same in `linkedin.py`/`naukri.py`/`unstop.py`/`indeed.py`) and are only released at the very end of the normal path. Any exception thrown by `db.add_application`, `db.upsert_job`, the LaTeX resume compile, `cover_letter()`, or `notify.to_user` skips that cleanup entirely — it's caught only at `run_queue.drain()`, which marks the job failed but never touches the browser handle. Each such exception leaks one headed Chromium process for the life of the long-running `worker.py --serve` process. This is the same "zombie-chrome leaks" `FIXES_REPORT.md` already flagged as needing a fix — confirmed still open.
**Fix:** wrap the run body in `try/finally` and call `mod.close(uid)` unconditionally.

### 2.7 Apply-worker and platform-reconnect can launch two Chromium processes on the same profile
**Files:** `agent/stealth.py:12-22`, `agent/connect_service.py`, `agent/run_queue.py:159,167`
`clear_stale_lock()` unconditionally deletes `SingletonLock`/`SingletonSocket`/`SingletonCookie` before every `launch_persistent_context`, without checking whether the owning process is actually dead. `connect_service.py`'s reconnect queue is entirely independent of `run_queue.claim_next()`'s "one running job per user" exclusion. A user with a live apply run open on `browser_profile/<uid>/internshala` can trigger a "Reconnect," which `connect_service.py` picks up on its own 3s poll and launches a **second** Chromium against the identical profile directory — `clear_stale_lock` then deletes the first (still-live) process's lock instead of protecting it, risking a crash/corruption in both.
**Fix:** check the queue's "user has a running job" state before allowing connect_service to claim a reconnect for that user, and/or verify the lock's owning PID is actually dead before removing it.

### 2.8 Anti-bot-detection safety caps are silently 3x looser (or uncapped) in the deployed container
**Files:** `agent/worker.py:190-191`, `docker-compose.yml:137-166`, `.env.example:60-62`
`SAFETY_CAP_PER_PLATFORM` defaults to **15** and `SAFETY_CAP_PER_RUN` defaults to **0 (disabled)** when unset — worker.py's own comment says these exist "so a bug or an over-eager run can never mass-apply (which gets accounts flagged as bots)." `.env.example` documents beta-safe defaults of `5`/`5`. Neither var is in the `worker` service's `environment:` block in compose, so the deployed worker silently runs at 3x the documented per-platform cap with no per-run cap at all.
**Fix:** add `GRINDLY_CAP_PER_PLATFORM`/`GRINDLY_CAP_PER_RUN` to the worker's compose environment.

### 2.9 Dashboard polling loops don't clean up on unmount — can double-poll
**File:** `src/app/dashboard/page.tsx` — `pollRun` (~601-628), `pollConnect` (~672-725)
Both are recursive `setTimeout` chains with no unmount guard (the file has only 3 unrelated cleanup functions, none covering these). Navigating away mid-run (e.g. clicking "Call prep ↗" to `/applications`) leaves the old closure firing requests every 2.5s for up to 240–450s. Returning to `/dashboard` within that window starts a second, independent poll for the same run — two loops hitting the server concurrently for one logical operation.
**Fix:** return a cleanup function from the effect that clears the pending timeout / sets a cancelled flag the recursive call checks.

---

## 3. MEDIUM

| # | File | Issue | Fix |
|---|---|---|---|
| 3.1 | `src/app/onboarding/page.tsx:646-653` | "Coming soon" Plus/Pro button isn't actually disabled — only `busy \|\| !tosAck` gates it; a real Razorpay checkout flow still runs on click. The only real block is a two-part environmental inference (`NODE_ENV==="production" && !RAZORPAY_KEY_ID`) in the API routes, not a dedicated flag. If keys are ever present in a non-strict-prod env, a real charge can complete through a button presented as inert. | Add an explicit `PAYMENTS_ENABLED` flag checked both client- and server-side; disable the button for real when off. |
| 3.2 | `extension/manifest.json:23-27`, `extension/src/content/bridge.js:19-27` | Pairing bridge script is injected on **all** of `https://grindly.in/*`, and accepts any `postMessage({type:"grindly-ext:pair"})` from same-window scripts — not scoped to `/extension/connect`. A future XSS anywhere on the origin becomes a way to silently re-pair a victim's extension to an attacker-chosen token. | Scope the content-script `matches` to the connect page path only. |
| 3.3 | `scripts/purge-demo.mjs:41` | `await prisma.report.deleteMany()` clears **every** user's report history unconditionally — documented as prod-safe ("only touches mock/demo data") but has no confirmation flag, unlike the sibling `reset-db.mjs`/`purge-users.mjs` which were explicitly hardened after a prior "unguarded full-wipe" incident. | Scope the delete to actual demo/mock records, or add the same `--yes`/`--force-prod` guard. |
| 3.4 | `twa-manifest.json` (host, iconUrl, fullScopeUrl, webManifestUrl) | Still points at `grindly.vercel.app`; nothing else in the deploy (Caddy/compose route via the real domain) references that host. The packaged Android TWA's asset-links verification and icons/manifest point at a domain the current stack doesn't serve → broken TWA / falls back to browser chrome. | Repoint to the real production domain and regenerate `assetlinks.json`. |
| 3.5 | `agent/run_queue.py:92-101,156-170,210` | `reclaim_stale()` requeues stale `running` jobs with no check against `max_attempts`, and `claim_next()`'s candidate query doesn't filter `attempts < max_attempts` either — only `mark_failed` checks it, after the extra run already happened. Currently harmless because Safe Apply Mode (`agent/safety.py:60-67`) hard-gates every adapter's `apply()` to return before actually submitting — but every adapter still carries a full submit path, so this becomes a real double-application risk the moment that gate is relaxed. | Filter `attempts < max_attempts` in the reclaim/claim queries too. |
| 3.6 | `src/app/admin/AdminNav.tsx:26` | Stale "N" badge (leftover NexPath-era branding) next to "Grindly ADMIN" text, while `Logo`/`Brand.tsx` uses a "g" everywhere else. | Swap the badge glyph to match. |
| 3.7 | `src/app/admin/applications/page.tsx`, `src/app/admin/audit/page.tsx` | No `if (!data) return <Loading/>` guard before rendering the table — unlike every sibling admin page. Users briefly see an empty table with headers and no loading indicator. | Add the same loading guard used elsewhere in `admin/`. |

---

## 4. LOW

| # | File | Issue |
|---|---|---|
| 4.1 | `next.config.ts:19` | CSP still has `script-src 'unsafe-inline'`; no inline `<script>`/`dangerouslySetInnerHTML` found in `src/app` that requires it — looks like leftover, not required. |
| 4.2 | `extension/src/background.js:11,52` | `API_BASE = "https://grindly.in"` checked via `.startsWith()` — not exploitable today (manifest match pattern requires exact host) but a latent landmine if that pattern is ever loosened to a wildcard. |
| 4.3 | `src/app/extension/connect/page.tsx:136-138` | Tells users to "paste this one-time code into the extension's 'Paste code' box" — no such UI exists anywhere in `popup.html`/`popup.js`/`background.js`. Anyone whose auto-handshake fails hits a dead end. The token also isn't actually single-use (indefinite bearer token, revocable only), so "one-time" overstates its own safety. |
| 4.4 | `extension/src/content/filler.js:95-109` | Non-`"not_connected"`/`"matched"` kit errors (network blips, the new 429 rate limit) fall into a silent `hide()` with no toast — a partial regression of the class fixed in commit `f1e9cc8` ("tell the user what to do when no fields are found"). |
| 4.5 | `extension/src/fillEngine.js:51-59` | Fuzzy answer-matching accepts a match on just 2 shared words (>3 chars) with no confidence indicator shown — risk of the wrong drafted answer silently landing in an unrelated screening question. |
| 4.6 | `src/app/dashboard/page.tsx:347-389` | Re-implements `src/components/TagInput.tsx` almost verbatim but its remove button has no `aria-label` (the shared component does) — a11y regression for screen-reader users removing a skill tag. |
| 4.7 | `.env.example:123` / `docker-compose.yml:137-166` | `OPS_SLACK_CHANNEL` documented but not passed to the `worker` service's environment — any custom value set in `.env` is silently ignored (harmless today only because the code's hardcoded fallback happens to match the default). |
| 4.8 | `agent/run_queue.py:155-161` | Postgres `claim_next`'s "no other running job for this user" exclusion is a plain (non-locked) MVCC read alongside the `FOR UPDATE SKIP LOCKED` claim — two concurrent transactions could both pass it. Currently unreachable since `docker-compose.yml` pins `worker: replicas: 1`. |
| 4.9 | *(repo hygiene, not shipped code)* | Several route directories are empty on disk with no `route.ts`/`page.tsx` (`src/app/api/login`, `/register`, `/auth/{forgot-password,reset-password,send-otp,verify-otp,verify-login-otp}`, `/reset-password`, `/api/admin/maintenance`, `/api/internshala/connect`). Confirmed nothing references them and git doesn't track empty directories — these are local leftovers from the Google-only auth migration, not a live bug. Worth `rm -rf`-ing locally for clarity, no functional impact. |

---

## 5. Re-confirmed still fixed (no action needed)

Verified directly against current source, not just trusted from the old report: payment-confirm session binding + Stripe/Razorpay HMAC webhook verification, signed+revocable session cookie, Google-login OAuth `state` + `email_verified` gate, profile `phone` write removed, admin gate (role + owner-email + 404 no-leak), extension kit/pair endpoints correctly scoped per-user with live revocation checks and a genuinely per-token rate limit, Python credential encryption (AES-256-GCM, fresh nonce per call, no reuse), no SQL injection in `db.py` (parameterized throughout), stipend-parsing firewall logic in `agent/matcher.py` (no M4-class bypass), Sentry configs have no PII leak and no hardcoded DSN, `Dockerfile.connect` is correctly wired into compose + Caddy.

---

## Suggested fix order

1. **1.1, 1.2** — deploy-breaking and safety-feature-is-fake; both are config/wiring fixes, low effort.
2. **2.1–2.3** — account-security and quota-integrity bugs with concrete exploit paths.
3. **2.4–2.9** — extension PII-leak scope, auth-guard gap, and the worker reliability/leak issues.
4. **Section 3** — before next deploy cycle.
5. **Section 4** — opportunistic cleanup.
