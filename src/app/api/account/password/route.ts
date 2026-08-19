import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { hashPassword, validatePassword, verifyPassword } from "@/lib/password";
import { revokeSessions } from "@/lib/session";
import { setUid } from "@/lib/session";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Change your own password.
 *
 * The only way to change a password used to be the forgot-password flow: sign
 * out, ask for a mail, wait, click. That is the recovery path for someone who
 * has LOST their password, and using it as the routine path means the one
 * security action people are told to do regularly is also the most tedious one
 * in the product.
 *
 * Three properties:
 *
 *   1. The current password is required, and verified before anything changes.
 *     A borrowed session — a shared laptop, a stolen cookie — must not be enough
 *     to lock the owner out of their own account.
 *   2. Every other session is revoked afterwards, and this one is re-issued.
 *     Changing a password is what you do when you think someone else has it, so
 *     leaving their cookie valid makes the change theatre. Re-issuing means the
 *     person who just did it is not signed out of the tab they are standing in.
 *   3. Rate limited per account. Verifying a password costs scrypt at 32 MB, so
 *     an authenticated loop here is a denial-of-service on our own box.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  if (await isRateLimited(`password:acct:${user.id}`, 10, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in an hour." },
      { status: 429 },
    );
  }

  let body: { current?: unknown; next?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.next === "string" ? body.next : "";

  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { passwordHash: true },
  });
  if (!row) return serverError("Account not found.", `account/password:${user.id}`);

  if (!row.passwordHash) {
    // A Google-only account has no password to replace. Offering one here would
    // silently create a second way into the account, which is a change to how it
    // is secured and belongs behind its own deliberate flow rather than behind a
    // form labelled "change password".
    return NextResponse.json(
      {
        error:
          "This account signs in with Google, so it has no password to change. " +
          "Manage it in your Google account.",
        code: "google_only",
      },
      { status: 400 },
    );
  }

  if (!(await verifyPassword(current, row.passwordHash))) {
    return NextResponse.json({ error: "That is not your current password." }, { status: 401 });
  }

  const problem = validatePassword(next);
  if (problem) return badRequest(problem);

  if (await verifyPassword(next, row.passwordHash)) {
    return badRequest("That is the password you already have. Choose a different one.");
  }

  try {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(next) },
    });
  } catch (e) {
    return serverError("Could not change the password.", `account/password: ${String(e)}`);
  }

  // Order matters: revoke every session, THEN mint a fresh cookie for this one.
  // Revoking increments the token version, which invalidates the cookie in this
  // browser too — so without the re-issue the user is signed out by their own
  // successful password change.
  await revokeSessions(user.id);
  await setUid(user.id);

  await audit(user.id, "password_changed");
  return NextResponse.json({
    ok: true,
    message: "Password changed. Every other device has been signed out.",
  });
}
