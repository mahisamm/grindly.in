import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid, clearUid } from "@/lib/session";
import { audit } from "@/lib/audit";

/**
 * Self-serve account deletion. The one auth surface the user genuinely controls:
 * a logged-in person can erase their own account and every row that hangs off it.
 *
 * The session cookie is SameSite=lax, and a DELETE is never a top-level GET
 * navigation, so the browser will not attach the cookie to a cross-site DELETE —
 * that is the CSRF defence. On top of it we require an explicit `{ confirm: true }`
 * body so a stray same-origin fetch can't nuke the account by accident.
 */
export async function DELETE(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  let confirm = false;
  try {
    const body = await req.json();
    confirm = body?.confirm === true;
  } catch {
    // no/invalid body — treated as unconfirmed below
  }
  if (!confirm) {
    return NextResponse.json({ error: "confirmation required" }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { email: true },
  });
  if (!user) {
    // Cookie points at a user that's already gone — clear it and move on.
    await clearUid();
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  // Record the deletion with userId:null so the audit row SURVIVES the cascade.
  // AuditLog.userId is onDelete:Cascade — an entry tagged with this uid would be
  // deleted along with the user, erasing the very trail we want to keep. Identity
  // is preserved in target/detail instead.
  await audit("account_deleted", { userId: null, target: user.email, detail: uid });

  // Every User relation is onDelete:Cascade EXCEPT PasswordResetToken, which
  // carries a bare user_id column with no FK — so it won't cascade. Clear it
  // explicitly in the same transaction so no orphan reset tokens linger.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({ where: { userId: uid } }),
    prisma.user.delete({ where: { id: uid } }),
  ]);

  await clearUid();
  return NextResponse.json({ ok: true });
}
