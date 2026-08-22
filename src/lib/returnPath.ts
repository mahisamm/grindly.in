/**
 * The one place a "go back to where you were" path is allowed to come from.
 *
 * `?next=` rides on sign-in links so a buyer sent from /pricing lands back on
 * /pricing, not on /app with the pass forgotten. It is also attacker-
 * controlled input on the most trusted page in the product, so it is reduced
 * to exactly one shape: an absolute PATH on this origin. Anything else — a
 * full URL, a protocol-relative `//evil.example`, a backslash trick, an empty
 * string — falls back to the app home. Pure and dependency-free so the sign-in
 * form (client) and the OAuth routes (server) validate identically.
 */
export function safeReturnPath(value: string | null | undefined, fallback = "/app"): string {
  if (!value) return fallback;
  if (value.length > 512) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (/[\r\n]/.test(value)) return fallback;
  return value;
}
