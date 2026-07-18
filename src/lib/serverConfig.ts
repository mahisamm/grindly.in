// Single source of truth for "which external services are wired" (Phase 2).
// Adapters, the health probe, startup instrumentation, and preflight all read
// from here so the answer is consistent everywhere. Reads env only — never
// returns secret values.

import { gmailScanEnabled } from "./googleOAuth";

export type SmsProvider = "fast2sms" | "msg91" | "twilio" | null;

/** Which SMS provider is configured, in priority order. null = none (OTP login
 *  will fail in production). */
export function smsProvider(): SmsProvider {
  if (process.env.FAST2SMS_API_KEY) return "fast2sms";
  if (process.env.MSG91_AUTH_KEY && process.env.MSG91_TEMPLATE_ID && process.env.MSG91_SENDER_ID) return "msg91";
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) return "twilio";
  return null;
}

export function emailConfigured(): boolean {
  return !!(process.env.EMAIL_SMTP_HOST && process.env.EMAIL_SMTP_USER);
}

export function llmConfigured(): boolean {
  return !!(
    process.env.GROQ_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.CEREBRAS_API_KEY ||
    process.env.MISTRAL_API_KEY
  );
}

export function googleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleOAuthBrandVerified(): boolean {
  return process.env.GOOGLE_OAUTH_BRAND_VERIFIED === "1";
}

// Gmail's gmail.readonly is a restricted scope on a separate OAuth client — it
// is NOT required for production (login doesn't touch it), so it stays out of
// missingProdConfig(). Surfaced here only so /api/health shows whether the
// interview tracker is live. See src/lib/googleOAuth.ts.
export { gmailScanEnabled } from "./googleOAuth";

// Payment is Razorpay (see src/lib/adapters/payment.ts). "stub" = no keys set,
// which is the intentional free-beta checkout. This only REPORTS the mode for
// /api/health; it deliberately does not gate prod-readiness (free beta is a
// valid deploy), so Razorpay keys are NOT in missingProdConfig().
export function paymentMode(): "razorpay" | "stub" {
  return process.env.RAZORPAY_KEY_ID ? "razorpay" : "stub";
}

export function encryptionKeyValid(): boolean {
  return /^[0-9a-fA-F]{64}$/.test(process.env.APP_ENCRYPTION_KEY || "");
}

export function baseUrlConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_BASE_URL);
}

/** The checked-in Prisma schema is PostgreSQL-only. */
export function databaseUrlConfigured(): boolean {
  return /^postgres(?:ql)?:\/\//i.test(process.env.DATABASE_URL || "");
}

/** Non-secret snapshot of service wiring — safe to expose on /api/health. */
export function serviceStatus() {
  return {
    sms: smsProvider(),                 // "fast2sms" | "msg91" | "twilio" | null
    email: emailConfigured(),
    llm: llmConfigured(),
    googleOAuth: googleOAuthConfigured(),
    gmailScan: gmailScanEnabled(),      // false until gmail.readonly is verified
    payment: paymentMode(),             // "razorpay" | "stub"
    encryptionKey: encryptionKeyValid(),
    baseUrl: baseUrlConfigured(),
  };
}

/** REQUIRED-for-production items that are missing. Empty = ready to take real
 *  users.
 *
 *  Beta auth is Google-only (see src/app/login/page.tsx), so SMS + SMTP are NOT
 *  required to launch — no phone OTP, and Google users never reset a password.
 *  Google OAuth IS required (it's the only way in). If password/phone login is
 *  re-enabled, move SMS + SMTP back into this list. */
export function missingProdConfig(): string[] {
  const miss: string[] = [];
  if (!databaseUrlConfigured()) miss.push("DATABASE_URL (valid Postgres connection)");
  if (!encryptionKeyValid()) miss.push("APP_ENCRYPTION_KEY (64 hex) — platform connect throws");
  if (!googleOAuthConfigured()) miss.push("GOOGLE_CLIENT_ID/SECRET — the only login method");
  if (!googleOAuthBrandVerified()) miss.push("GOOGLE_OAUTH_BRAND_VERIFIED — consent screen must show Grindly");
  if (!baseUrlConfigured()) miss.push("NEXT_PUBLIC_APP_URL — OAuth redirect + email links");
  // NOT required: EMAIL_SMTP_HOST/USER/PASS. This line was previously here and
  // contradicted the comment above — Google-only auth means there's no password
  // to reset, so a missing SMTP config can't legitimately block a production
  // deploy. Found and fixed as a bug during the master/hosted-branch merge.
  return miss;
}
