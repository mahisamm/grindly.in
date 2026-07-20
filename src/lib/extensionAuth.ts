// Extension bearer-token auth. The browser extension fills forms inside the
// user's own browser, so it can't share the httpOnly `ip_uid` cookie — it holds
// its own long-lived token instead. We store only sha256(token): the raw value
// is generated once at pairing, handed to the extension, and never persisted
// server-side, so a database leak yields nothing replayable.
import crypto from "node:crypto";
import { prisma } from "./prisma";

export type ExtensionAuth = { userId: string; tokenId: string };

const PREFIX = "gx_"; // recognisable in logs/headers without revealing anything

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** Mint a new token for a user, store its hash, return the RAW token (shown once). */
export async function issueToken(userId: string, label = "Browser extension"): Promise<string> {
  const raw = PREFIX + crypto.randomBytes(32).toString("base64url");
  await prisma.extensionToken.create({
    data: { userId, tokenHash: hashToken(raw), label },
  });
  return raw;
}

/** Extract a bearer token from a request's Authorization header, or null. */
export function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

/**
 * Verify a raw token and return its owner, or null. Looks up by hash (never by
 * raw value), rejects revoked tokens, and best-effort stamps lastUsedAt so the
 * user can see which paired browsers are active. A wrong/absent token is null,
 * never an exception — callers turn that into a 401.
 */
export async function verifyToken(raw: string | null): Promise<ExtensionAuth | null> {
  if (!raw || !raw.startsWith(PREFIX)) return null;
  const row = await prisma.extensionToken
    .findUnique({ where: { tokenHash: hashToken(raw) }, select: { id: true, userId: true, revokedAt: true } })
    .catch(() => null);
  if (!row || row.revokedAt) return null;
  prisma.extensionToken
    .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  return { userId: row.userId, tokenId: row.id };
}

/** Verify straight off a Request. Convenience for route handlers. */
export async function authenticateExtension(req: Request): Promise<ExtensionAuth | null> {
  return verifyToken(bearerFrom(req));
}
