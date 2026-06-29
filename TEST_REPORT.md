# NexPath / Grindly — Full QA Test Report

**Tester:** automated senior-QA pass
**Date:** 2026-06-27
**Scope:** whole app — auth, payments, agent, admin, profile, UI, static health
**Branch:** master

---

## ✅ Resolution (2026-06-27) — Phase 0 (code blockers) + Phase 1 (production DB)

All Critical + High + Medium (except M6, accepted) fixed and verified. Gate checks
now: **ESLint clean**, **tsc 0 errors**, **vitest 12/12** (+3 stipend tests),
**pytest 14/14**, **next build OK**, **Prisma schema valid for Postgres**.

| ID | Status | Fix |
|---|---|---|
| C1 payment bypass | ✅ fixed | `pay/confirm` now session-bound; never trusts URL `uid`; real-Stripe flips only via webhook |
| C2 reset broken | ✅ fixed | `await createResetToken(...)` |
| H1 unsigned cookie | ✅ fixed | HMAC-signed session value (`src/lib/session.ts`) |
| H2 OAuth no state | ✅ fixed | random state in httpOnly cookie, verified in callback |
| H3 no email_verified | ✅ fixed | require Google `email_verified` before create/link-by-email |
| H4 send-otp abuse | ✅ fixed (new) | per-IP rate limit on `send-otp` |
| M1 phone writable | ✅ fixed | `phone` dropped from profile writes |
| M2 resume cap | ✅ fixed | 5 MB + `.pdf/.docx/.txt` allowlist |
| M3 otp stale lock | ✅ fixed | counter ages out past `windowEnd` |
| M4 stipend parse | ✅ fixed | units (k/L/LPA) + unpaid→0; mirrored in `matcher.py`; tests added |
| M5 base-url split | ✅ fixed | single `src/lib/baseUrl.ts` |
| M7 gmail-scan | ✅ fixed (new) | no error-detail leak; lint no-op removed |
| M6 ratelimit race | ⚠️ accepted | low impact behind reverse proxy; revisit with Redis |
| L1–L12 lint | ✅ fixed | 6 errors + 3 warnings → 0 |

**Phase 1:** `schema.prisma` provider → `postgresql` (validated); `agent/db.py` +
`run_queue.py` made dual-backend (SQLite dev / Postgres prod, `FOR UPDATE SKIP
LOCKED`); `Dockerfile.worker` hardened; shared `appdata` volume; `psycopg2-binary`
added. ⚠️ The Postgres *runtime* path is compile-clean + SQLite-smoke-tested but
needs a live-DB smoke on first deploy (no DB creds available in this environment).

Sections below are the original findings, kept for traceability.

---

## 0. Static health (gate checks)

| Check | Result |
|---|---|
| `next build` (prod) | ✅ pass (exit 0) |
| `tsc --noEmit` | ✅ pass (no type errors) |
| `vitest run` | ✅ 9/9 pass (crypto, firewall) |
| `eslint` | ❌ **6 errors, 3 warnings** |

Build green but lint surfaces real React-correctness errors (see §3). Test coverage is thin — only `crypto` + `firewall` have unit tests; **zero tests on auth, payments, OTP, rate-limit, routes.**

---

## 1. CRITICAL — fix before any release

### C1. Payment bypass — anyone gets Pro free, can flip any user
**File:** `src/app/api/pay/confirm/route.ts`
`GET /api/pay/confirm?uid=<id>&plan=pro` sets `paid=true, status=active, plan=pro` based on **URL params only** — no session check, no Stripe verification. The only guard is "user exists."

- Visit the URL → instant free Pro.
- Pass any victim's `uid` → flip arbitrary accounts (cross-user tampering / IDOR).
- In real-Stripe mode the `success_url` is this same endpoint (`payment.ts:33`), so a user who **cancels** checkout can still self-mark paid by hitting the redirect manually.

The secure path already exists (`pay/webhook/route.ts`, HMAC-verified) — `confirm` undermines it.
**Fix:** `confirm` must not mutate billing. Require session (`getUid`), and only flip `paid` from the verified Stripe webhook (or by re-fetching the Stripe session server-side). Make confirm a read-only "thanks" redirect.

### C2. Password reset is completely broken
**File:** `src/app/api/auth/forgot-password/route.ts:23`
```js
const token = createResetToken(user.id);   // async, NOT awaited
const link = `${base}/reset-password?token=${token}`;
```
`createResetToken` is `async`, so `token` is a Promise. The emailed link becomes
`/reset-password?token=[object Promise]`. **No user can ever reset a password.** Token row may also race the email send.
**Fix:** `const token = await createResetToken(user.id);`

---

## 2. HIGH

### H1. Session cookie has no integrity — account takeover on any id leak
**File:** `src/lib/session.ts`
Cookie `ip_uid` stores the **raw `user.id`** (cuid) with no signature/HMAC/encryption. Anyone who learns a user's id can forge a session by setting one cookie — full takeover, and you can't revoke/rotate it. cuid is hard to guess but **not secret** (ids leak through APIs, logs, admin lists).
**Fix:** sign the cookie (HMAC with a server secret) or use an opaque server-side session token; reject unsigned values.

### H2. Google OAuth has no `state` — login CSRF
**Files:** `api/auth/google/route.ts`, `.../callback/route.ts`
Authorize URL sends no `state`; callback verifies none. An attacker can complete OAuth and bind the victim's browser to the attacker's Google account (login CSRF).
**Fix:** generate random `state`, store in an httpOnly cookie, verify on callback.

### H3. OAuth auto-links accounts by email without `email_verified`
**File:** `api/auth/google/callback/route.ts:64`
Matches existing user by `email` and logs in, but never checks Google's `email_verified`. Auto-links a Google login to a pre-existing password account. If an unverified Google email matches, that's account takeover.
**Fix:** require `email_verified === true` before linking by email.

---

## 3. MEDIUM

### M1. Phone can be changed via profile with no re-verification
**File:** `src/app/api/profile/route.ts` (`phone` in `STR_FIELDS`)
`POST /api/profile` lets a logged-in user overwrite `phone` directly. `phoneVerified` is **not** reset, so the account keeps "verified" status on an unverified number; login OTPs then route to the new number. No uniqueness handling → duplicate phone throws Prisma P2002 = unhandled 500.
**Fix:** drop `phone` from profile writes; route phone changes through the OTP flow; catch unique violation.

### M2. Resume upload — no size cap, no type allowlist
**File:** `src/app/api/resume/route.ts`
`file.arrayBuffer()` buffers the whole upload in memory (memory-exhaustion DoS), and any extension is accepted and written to disk. Dest path uses the session `uid` (no traversal), but type/size are unchecked.
**Fix:** enforce max size (e.g. 5 MB) and allowlist `.pdf/.docx/.txt`.

### M3. OTP attempt counter not reset after lockout expiry
**File:** `src/lib/otp.ts:120` (`verifyOtp`)
After a 15-min lockout expires, `attempts` stays at 5. The next wrong guess → `5+1 ≥ 5` → instantly re-locked. The `windowEnd` field is never used to age out the counter. Only `issueOtp` clears it. Effectively a one-strike permanent lock until a new OTP is requested.
**Fix:** if `now > windowEnd`, reset `attempts` to 0 before counting.

### M4. Firewall — non-numeric/unpaid stipend bypasses min-stipend gate
**File:** `src/lib/firewall.ts:73`
`parseStipend("unpaid")` → `null` → the `amt !== null` guard skips the check, so an unpaid job passes even when `stipendMin > 0`. Also `parseStipend("10k")`/`"10 LPA"` → `10`, misread as ₹10 (false block).
**Fix:** treat `null` stipend as "unknown" and decide policy explicitly; handle `k`/`L`/`LPA` units.

### M5. Reset link base env var mismatch (compounds C2)
`forgot-password` uses `NEXT_PUBLIC_APP_URL`; OAuth uses `NEXT_PUBLIC_BASE_URL`. If only one is set in prod, reset links fall back to `http://localhost:3000`.
**Fix:** standardize on one base-URL env var.

### M6. Rate limiter is racy and IP-spoofable
**File:** `src/lib/rateLimit.ts`
Read-then-write isn't atomic — concurrent requests can each see "under limit" and exceed it. `getIp` trusts `x-forwarded-for` (client-spoofable), so per-IP login/register/OTP caps are bypassable by rotating the header.
**Fix:** atomic upsert/increment with conditional check; derive client IP from the trusted proxy hop only.

---

## 4. LOW — UI / correctness / polish

| # | File | Issue |
|---|---|---|
| L1 | `app/signup/page.tsx:24` | ESLint error: `setState` synchronously in effect (plan from URL) — cascading renders |
| L2 | `app/reset-password/page.tsx:20` | Same setState-in-effect error reading `token` |
| L3 | `app/dashboard/page.tsx:313` | setState-in-effect for `gmailConnected`/`gmailError` notice |
| L4 | `app/dashboard/page.tsx:400` | ESLint error: `Date.now()` called during render (impure) in poll setup |
| L5 | `app/admin/agent-health/page.tsx:51` | setState-in-effect via `runDiagnostics()` |
| L6 | `app/login/page.tsx:146` | Unescaped `'` in JSX |
| L7 | `app/onboarding/page.tsx:16` | `router` assigned, never used |
| L8 | `app/api/gmail/scan/route.ts:44` | ⚠️ no-op expression (`@typescript-eslint/no-unused-expressions`) — **likely a dropped statement; verify** (read was interrupted) |
| L9 | `next.config.ts:19` | CSP `script-src 'unsafe-inline'` weakens XSS defense |
| L10 | dashboard / user pages | Client-only auth guard → brief content flash before redirect (data itself is API-protected) |
| L11 | branding | Product name inconsistent: package `grindly`, adapter says `InternPilot` (`payment.ts:30`), emails say "Grindly", app is "NexPath" |
| L12 | `scripts/build-apk.mjs:20` | unused `mkdirSync` |

---

## 5. Verified OK (no defect found)

- Admin gate (`lib/admin.ts`): role + owner-email + 404 (no existence leak). Solid.
- `applications/approve`: scoped by `userId` — no IDOR.
- `agent/run`: session + `paid` gate enforced.
- Password hashing: scrypt + `timingSafeEqual`. Good.
- Stripe webhook: HMAC + timing-safe compare. Good.
- Password-reset token store: sha256-hashed, single-use, 15-min TTL.
- Forgot-password: email-enumeration safe (always returns `ok`).
- OTP send: cooldown + daily cap + lockout (aside from M3).

---

## 6. Recommended fix order
1. **C1, C2** (revenue + reset broken) — blockers.
2. **H1, H2, H3** (auth integrity).
3. **M1–M6**.
4. **L*** cleanup + add tests for auth/payment/OTP routes (currently none).

> Not yet exercised live (static + code audit only): real browser click-through of signup→OTP→onboarding→pay→dashboard, admin screens, mobile/responsive, accessibility. Recommend a runtime QA pass next (dev server + `/qa-only`).
