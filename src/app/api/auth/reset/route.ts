import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isRateLimited, isRateLimitedByIp } from "@/lib/rateLimit";
import { hashPassword, validatePassword } from "@/lib/password";
import { revokeSessions } from "@/lib/session";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Finish a password reset.
 *
 * Three properties, each guarding a specific way this gets abused:
 *
 *   1. The token is looked up BY HASH. The database never held the usable value,
 *      so a leaked backup or a stray log line is not a set of skeleton keys.
 *   2. It is consumed inside the same conditional update that spends it, so a
 *      replayed link cannot set the password twice.
 *   3. Every existing session is revoked. Someone resetting a password has
 *      usually lost control of the account; leaving the attacker's cookie valid
 *      makes the reset theatre.
 */
export async function POST(req: Request) {
  if (await isRateLimitedByIp(req, "reset", 40, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const token = (body.token ?? "").trim();
  // Narrowed here rather than cast later: a non-string becomes "", which
  // fails the length rule and produces the same message a two-character
  // password gets. `validatePassword` guards this too, for callers that
  // do not narrow first.
  const password = typeof body.password === "string" ? body.password : "";
  if (!token) {
    return NextResponse.json({ error: "That reset link is incomplete." }, { status: 400 });
  }

  // The IP-keyed limit above is skipped entirely without a trusted proxy, so
  // this route needs a key that always exists. The token is that key: it is the
  // thing being guessed, and every submission carries one. Without it an
  // unauthenticated caller can spin scrypt (32 MB, ~100 ms a go) in a loop.
  if (await isRateLimited(`reset:tok:${token.slice(0, 64)}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const problem = validatePassword(password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const tokenHash = createHash("sha256").update(token).digest("hex");
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { id: true, userId: true, expiresAt: true, usedAt: true },
  });

  // One message for expired, used and unknown. Distinguishing them tells an
  // attacker which of their guesses were real tokens.
  const dead = NextResponse.json(
    { error: "That reset link has expired or has already been used. Ask for a new one." },
    { status: 400 },
  );
  if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) return dead;

  const passwordHash = await hashPassword(password);

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Conditional: only the first caller to spend this token gets to act.
      const spent = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (spent.count === 0) return false;
      await tx.user.update({ where: { id: row.userId }, data: { passwordHash } });
      return true;
    });
    if (!result) return dead;
  } catch (e) {
    console.error("[reset] failed:", e);
    return NextResponse.json({ error: "Could not reset the password." }, { status: 500 });
  }

  await revokeSessions(row.userId);
  await audit(row.userId, "password_reset");
  return NextResponse.json({ ok: true });
}
