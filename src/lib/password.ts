/**
 * Password hashing with scrypt from Node's own crypto.
 *
 * The previous build was Google-OAuth-only, which meant the whole product was
 * unreachable without a Google Cloud project, a published consent screen, and a
 * verified brand — three things that stand between a developer cloning this repo
 * and seeing it work, and between a user with no Google account and using it at
 * all. Google sign-in is still here and still preferred; it is no longer the
 * only door.
 *
 * scrypt rather than bcrypt/argon2 because it ships with Node. Adding a native
 * dependency to a Next app that has to build in a slim container is a real cost,
 * and scrypt at these parameters is a sound choice — it is memory-hard, which is
 * the property that matters against GPU cracking.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// N=2^15 is ~32 MB and ~100ms on a modest server: enough to make offline
// cracking expensive, cheap enough that a login is not a visible pause. maxmem
// must be set explicitly — Node's default is 32 MB and these parameters need
// slightly more than that, so the call throws without it. That is a genuinely
// confusing failure mode ("invalid scrypt params" on a correct password) and it
// is why the number is written out rather than left implicit.
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

const PREFIX = "scrypt";

/** Minimum length we accept. Length beats composition rules; NIST agrees. */
export const MIN_PASSWORD_LENGTH = 10;

/**
 * A password long enough and not obviously one of the handful everyone picks.
 * Returns null when acceptable, or a message written for the person typing it.
 */
export function validatePassword(password: string): string | null {
  const value = password ?? "";
  if (value.length < MIN_PASSWORD_LENGTH) {
    return `Use at least ${MIN_PASSWORD_LENGTH} characters — length matters more than symbols.`;
  }
  if (value.length > 200) {
    return "That password is longer than 200 characters.";
  }
  const flat = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const COMMON = [
    "password", "12345678", "qwerty", "letmein", "welcome", "admin",
    "iloveyou", "abc123", "1234567890", "grindly", "resume", "changeme",
  ];
  if (COMMON.some((c) => flat === c || flat.startsWith(c) && flat.length <= c.length + 3)) {
    return "That password is one of the most commonly used ones. Pick something else.";
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return [PREFIX, N, R, P, salt.toString("hex"), key.toString("hex")].join("$");
}

/**
 * Constant-time verify. Returns false for any malformed stored value rather
 * than throwing — a corrupt row must fail the login, not the request.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;

  const [, nStr, rStr, pStr, saltHex, keyHex] = parts;
  const n = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row: scrypt with a huge N is a
  // denial-of-service against ourselves.
  if (n > 1 << 20 || r > 32 || p > 16) return false;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(keyHex, "hex");
    if (expected.length === 0) return false;
    actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, {
      N: n, r, p, maxmem: 128 * n * r * 2,
    });
  } catch {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Normalise an email for storage and lookup.
 *
 * Lower-cased and trimmed, so `Priya@Example.com` and `priya@example.com` are
 * one account. The old schema had a case-sensitive unique index on email and
 * carried it as an accepted debt; here it is just fixed, because two accounts
 * differing only in capitalisation is a support ticket and a security question
 * ("which one did the password reset go to?") rather than a feature.
 */
export function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  const value = normalizeEmail(email);
  return value.length <= 254 && EMAIL_RE.test(value);
}
