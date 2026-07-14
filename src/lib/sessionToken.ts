// Pure HMAC sign/verify for the session cookie value. No Next/cookie/DB imports
// so it's trivially unit-testable. session.ts wraps these with the cookie store
// and the DB-backed token-version (revocation) check.
//
// Format: `<uid>.<issuedAtMs>.<tokenVersion>.<hex-hmac>`. Secret =
// APP_ENCRYPTION_KEY. The issued-at timestamp bounds replay (rejected after
// MAX_AGE_MS), and the token version lets session.ts revoke a specific user's
// cookies on logout without rotating the global secret (which would log out
// everyone). A leaked user id is useless without the secret; tampered/unsigned/
// stale values are rejected here, revoked ones in session.ts.
import { createHmac, timingSafeEqual } from "node:crypto";

// Server-side hard expiry for a signed session. Matches the cookie maxAge in
// session.ts (30 days) — but this one is enforced by us, not the browser, so a
// stolen cookie stops working after the window even if the client keeps sending
// it. Logout revokes sooner via the token-version bump (see session.ts).
const MAX_AGE_MS = 60 * 60 * 24 * 30 * 1000;

function secret(): string {
  return process.env.APP_ENCRYPTION_KEY ?? "";
}

export type SessionClaims = { uid: string; tokenVersion: number };

export function signSession(
  uid: string,
  tokenVersion: number,
  issuedAtMs: number = Date.now(),
): string {
  const payload = `${uid}.${issuedAtMs}.${tokenVersion}`;
  const mac = createHmac("sha256", secret()).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

/**
 * Returns the claims if the value is correctly signed AND not expired, else
 * null. Does NOT check revocation — that needs the DB, so session.getUid()
 * compares the returned tokenVersion against the user's current version.
 */
export function unsignSession(value: string): SessionClaims | null {
  const lastDot = value.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const payload = value.slice(0, lastDot); // `<uid>.<issuedAtMs>.<tokenVersion>`
  const mac = value.slice(lastDot + 1);
  const expected = createHmac("sha256", secret()).update(payload).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Signature verified — parse the payload. uid is a cuid (no dots), so the
  // payload splits cleanly into exactly three parts.
  const parts = payload.split(".");
  if (parts.length !== 3) return null;
  const [uid, issuedAtStr, versionStr] = parts;
  if (!uid) return null;

  const issuedAtMs = Number(issuedAtStr);
  if (!Number.isFinite(issuedAtMs)) return null;
  const age = Date.now() - issuedAtMs;
  if (age < 0 || age > MAX_AGE_MS) return null;

  const tokenVersion = Number(versionStr);
  if (!Number.isInteger(tokenVersion) || tokenVersion < 0) return null;

  return { uid, tokenVersion };
}
