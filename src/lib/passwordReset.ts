import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

const TTL_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createResetToken(userId: string): Promise<string> {
  // Invalidate any existing tokens for this user
  await prisma.passwordResetToken.updateMany({
    where: { userId, used: false },
    data: { used: true },
  });

  const token = randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TTL_MS);

  await prisma.passwordResetToken.create({
    data: { userId, tokenHash, expiresAt },
  });

  return token;
}

/** Returns userId if token is valid and not expired; null otherwise. Consumes the token. */
export async function consumeResetToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);
  const entry = await prisma.passwordResetToken.findUnique({ where: { tokenHash } });

  if (!entry || entry.used || entry.expiresAt < new Date()) return null;

  await prisma.passwordResetToken.update({
    where: { id: entry.id },
    data: { used: true },
  });

  return entry.userId;
}
