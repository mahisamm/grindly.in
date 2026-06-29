// Pure HMAC sign/verify for the session cookie value. No Next/cookie imports so
// it's trivially unit-testable. session.ts wraps these with the cookie store.
//
// Format: `<uid>.<hex-hmac>`. Secret = APP_ENCRYPTION_KEY. A leaked user id is
// useless without the secret, and tampered/unsigned values are rejected.
import { createHmac, timingSafeEqual } from "node:crypto";

function secret(): string {
  return process.env.APP_ENCRYPTION_KEY ?? "";
}

export function signSession(uid: string): string {
  const mac = createHmac("sha256", secret()).update(uid).digest("hex");
  return `${uid}.${mac}`;
}

/** Returns the uid if the value is correctly signed, else null. */
export function unsignSession(value: string): string | null {
  const i = value.lastIndexOf(".");
  if (i <= 0) return null;
  const uid = value.slice(0, i);
  const mac = value.slice(i + 1);
  const expected = createHmac("sha256", secret()).update(uid).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length === 0 || a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return uid;
}
