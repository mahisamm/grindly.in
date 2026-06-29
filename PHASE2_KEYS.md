# Phase 2 — Service keys runbook

Code is wired and validated. This is the **only** part that needs your accounts.
Paste each value into `.env` (prod: the server's env / docker `.env`). After
setting them, confirm with `npm run preflight` or `GET /api/health` (`missing`
should be empty and `prodReady: true`).

Priority: **SMS + SMTP + APP_ENCRYPTION_KEY** unblock real signups. LLM + Google
OAuth are optional (app degrades gracefully without them).

---

## 1. APP_ENCRYPTION_KEY (1 min) — REQUIRED

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Paste into `APP_ENCRYPTION_KEY=`. **Generate a fresh one for prod — never reuse the dev key.**

---

## 2. SMS OTP — REQUIRED (pick ONE)

Without this, **login/signup crash in production** (the OTP can't be sent).

### Option A — Fast2SMS (India, fastest to start, no DLT template)
1. Sign up at https://www.fast2sms.com (phone + email).
2. Add wallet credit (small amount; OTP route is cheap).
3. Dashboard → **Dev API** → copy the **API Key**.
4. `.env`: `FAST2SMS_API_KEY=<key>`
- Uses the **OTP route** — delivers "Your OTP is <code>" to the 10-digit number. No template approval needed.

### Option B — MSG91 (India, scales, needs DLT template)
1. Sign up at https://msg91.com.
2. Complete **DLT** registration (PAN/business) and create an **OTP template** with an `##OTP##` variable.
3. Get: **Auth Key**, the approved **Template ID**, your **Sender ID** (6-char header).
4. `.env`:
   ```
   MSG91_AUTH_KEY=<auth key>
   MSG91_TEMPLATE_ID=<template id>
   MSG91_SENDER_ID=<6-char sender>
   MSG91_OTP_VAR=OTP          # match the variable name in your template
   ```
- DLT approval can take a few days — **start this early** if you choose MSG91.

### Option C — Twilio (international)
1. https://twilio.com → trial gives ~$15 credit.
2. Buy/verify a sender number.
3. `.env`:
   ```
   TWILIO_ACCOUNT_SID=AC...
   TWILIO_AUTH_TOKEN=...
   TWILIO_FROM_NUMBER=+1...
   ```
- Twilio→India needs sender-ID + DLT paperwork too; fine for testing with verified numbers.

---

## 3. SMTP email — REQUIRED (password reset + notifications)

Without this, reset emails are silently dropped in prod.

### Brevo (300 emails/day free)
1. Sign up at https://www.brevo.com.
2. **SMTP & API** → **SMTP** → copy host (`smtp-relay.brevo.com`), port `587`, login, and the **SMTP key** (password).
3. `.env`:
   ```
   EMAIL_SMTP_HOST=smtp-relay.brevo.com
   EMAIL_SMTP_PORT=587
   EMAIL_SMTP_USER=<brevo login>
   EMAIL_SMTP_PASS=<brevo SMTP key>
   EMAIL_FROM=Grindly <noreply@yourdomain.com>
   ```
4. Verify your sender/domain in Brevo so mail isn't marked spam.

(Resend works the same — SMTP host `smtp.resend.com`.)

---

## 4. LLM — optional (better job matching)

Without a key the agent uses heuristic matching (works, less accurate).

### Groq (14k req/day free — one key covers 2 of the 5 providers)
1. https://console.groq.com → **API Keys** → create key.
2. `.env`: `GROQ_API_KEY=<key>`

(Optional extras for the ensemble: `GEMINI_API_KEY` (aistudio.google.com),
`CEREBRAS_API_KEY` (cloud.cerebras.ai), `MISTRAL_API_KEY` (console.mistral.ai).)

---

## 5. Google OAuth — optional ("Sign in with Google")

Without it the Google button returns 503; email/phone signup still works.

1. https://console.cloud.google.com → create project.
2. **APIs & Services → OAuth consent screen** → External → fill app name + support email.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
4. **Authorized redirect URIs** — add your real domain (set this AFTER you pick the
   domain in Phase 3, or you'll re-edit):
   ```
   https://YOUR_DOMAIN/api/auth/google/callback
   ```
   (For local: `http://localhost:3000/api/auth/google/callback`.)
5. `.env`:
   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   NEXT_PUBLIC_APP_URL=https://YOUR_DOMAIN
   ```

---

## Verify

```
npm run preflight          # local: ✓/! per service
curl https://YOUR_DOMAIN/api/health   # prod: { prodReady: true, missing: [] }
```

`prodReady: true` = real users can sign up, log in, and reset passwords.
Next: **Phase 3 — deploy** (VPS + domain + SSL + `docker compose up`).
