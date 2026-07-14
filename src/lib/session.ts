import { cookies } from "next/headers";
import { prisma } from "./prisma";
import { signSession, unsignSession } from "./sessionToken";

const COOKIE = "ip_uid";
const MAX_AGE_SEC = 60 * 60 * 24 * 30;

/**
 * Returns the logged-in user's id, or null. Verifies the cookie's HMAC + expiry
 * (sessionToken) AND that its token version still matches the user's current
 * version in the DB — so a cookie whose version was bumped by logout is
 * rejected even though it's cryptographically valid.
 */
export async function getUid(): Promise<string | null> {
  const c = await cookies();
  const raw = c.get(COOKIE)?.value;
  if (!raw) return null;
  const claims = unsignSession(raw);
  if (!claims) return null;

  // Revocation check: reject a cookie issued before the user's current version.
  const user = await prisma.user
    .findUnique({ where: { id: claims.uid }, select: { tokenVersion: true } })
    .catch(() => null);
  if (!user) return null;
  if (claims.tokenVersion !== user.tokenVersion) return null;

  return claims.uid;
}

export async function setUid(uid: string) {
  // Stamp the current token version into the cookie so a later logout (which
  // increments it) invalidates this exact cookie.
  const user = await prisma.user
    .findUnique({ where: { id: uid }, select: { tokenVersion: true } })
    .catch(() => null);
  const tokenVersion = user?.tokenVersion ?? 0;

  const c = await cookies();
  c.set(COOKIE, signSession(uid, tokenVersion), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
    secure: process.env.NODE_ENV === "production",
  });
}

/**
 * Revoke every session for a user by bumping their token version. Existing
 * cookies (which carry the old version) are rejected by getUid() on the next
 * request. Used by logout; reusable for password change / force-logout.
 */
export async function revokeSessions(uid: string) {
  await prisma.user
    .update({ where: { id: uid }, data: { tokenVersion: { increment: 1 } } })
    .catch(() => null);
}

export async function clearUid() {
  const c = await cookies();
  c.delete(COOKIE);
}
