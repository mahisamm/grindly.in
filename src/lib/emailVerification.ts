/**
 * Proving that an address reaches the person who claims it.
 *
 * Nothing here gates signing in, and that is deliberate. A resume tool that
 * locks someone out of the product they just signed up for until they go and
 * check their inbox loses more people than it protects, and the free tier
 * exists precisely so they can see the thing work in the first minute.
 *
 * What verification is for is narrower and real: an address that was never
 * proven cannot be trusted to reach anyone. A typo at signup produces an
 * account with no recovery path — the password reset goes to a mailbox that
 * does not exist, and the only way back is a human with database access. It is
 * also the guard on changing the address later: an attacker with a borrowed
 * session should not be able to move the account somewhere the owner cannot
 * follow.
 *
 * The token is stored as a hash for the same reason PasswordResetToken is: a
 * table of usable tokens hands out accounts the moment a backup leaks.
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import { sendEmail } from "./adapters/email";
import { appUrl } from "./config";

/**
 * How long a verification link works.
 *
 * Longer than a password reset's 45 minutes, because this one is not a
 * credential for anything — the worst a stolen verification link does is prove
 * an address the holder already controls — and because people genuinely do get
 * to their inbox the next morning.
 */
export const TTL_MS = 24 * 60 * 60 * 1000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a link and send it. `email` is the address being proven, which for a
 * change is the NEW one and is not yet on the user row.
 *
 * Returns the raw token so a development server with no SMTP can show it. Every
 * caller must gate revealing it the way lib/auth's forgot route does — the same
 * three conditions, for the same reason.
 */
export async function issueVerification(
  userId: string,
  email: string,
  purpose: "signup" | "change",
): Promise<{ token: string; stub: boolean }> {
  // Invalidate anything outstanding for this user. Two live links means an
  // older one — possibly pointing at an address the user has since thought
  // better of — still works.
  await prisma.emailVerificationToken
    .updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } })
    .catch(() => null);

  const token = randomBytes(32).toString("base64url");
  await prisma.emailVerificationToken.create({
    data: {
      userId,
      email,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });

  const link = `${appUrl()}/verify?token=${token}`;
  const hours = Math.round(TTL_MS / 3_600_000);
  const delivery = await sendEmail({
    to: email,
    subject:
      purpose === "change"
        ? "Confirm your new Grindly address"
        : "Confirm your email address",
    body:
      purpose === "change"
        ? `Someone asked to move a Grindly account to this address.\n\n` +
          `Open this link to confirm it:\n\n${link}\n\n` +
          `It works once and expires in ${hours} hours. Until you open it, the ` +
          `account keeps its current address.\n\n` +
          `If this was not you, ignore this — nothing has changed.`
        : `Welcome to Grindly.\n\nOpen this link to confirm this address:\n\n${link}\n\n` +
          `It works once and expires in ${hours} hours.\n\n` +
          `You can use Grindly without doing this. Confirming means we can ` +
          `actually reach you if you ever need to reset your password.`,
  });

  return { token, stub: delivery.stub };
}

export type ConsumeResult =
  | { ok: true; userId: string; email: string; changed: boolean }
  | { ok: false; reason: "dead" | "taken" | "error" };

/**
 * Spend a verification token.
 *
 * Marks the address verified, and — when the token was issued for a change —
 * moves the account onto it. Both happen in one transaction with the token
 * consumed conditionally, so a link that is opened twice, or by a mail scanner
 * and then by a person, cannot apply twice.
 *
 * Sessions are NOT revoked here. Changing the address does not change the
 * credential, the person doing it is signed in already, and logging someone out
 * of the tab they are working in for confirming their own email is a punishment
 * for doing the right thing. The password routes revoke; this does not.
 */
export async function consumeVerification(token: string): Promise<ConsumeResult> {
  const row = await prisma.emailVerificationToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, email: true, expiresAt: true, usedAt: true },
  });

  // One answer for expired, spent and unknown — distinguishing them tells a
  // guesser which of their guesses were real tokens.
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "dead" };
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const spent = await tx.emailVerificationToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count === 0) return { ok: false, reason: "dead" } as const;

      const user = await tx.user.findUnique({
        where: { id: row.userId },
        select: { email: true },
      });
      const changed = user?.email !== row.email;

      if (changed) {
        // Re-checked here rather than only at request time: the address may
        // have been claimed by someone else in the hours between asking and
        // clicking, and the unique index would otherwise throw a raw error.
        const taken = await tx.user.findUnique({
          where: { email: row.email },
          select: { id: true },
        });
        if (taken && taken.id !== row.userId) return { ok: false, reason: "taken" } as const;
      }

      await tx.user.update({
        where: { id: row.userId },
        data: { email: row.email, emailVerifiedAt: new Date() },
      });

      return { ok: true, userId: row.userId, email: row.email, changed } as const;
    });
  } catch (e) {
    console.error("[verify] consume failed:", (e as Error).message);
    return { ok: false, reason: "error" };
  }
}
