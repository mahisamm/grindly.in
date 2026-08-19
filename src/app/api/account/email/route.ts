import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { isValidEmail, normalizeEmail, verifyPassword } from "@/lib/password";
import { issueVerification } from "@/lib/emailVerification";
import { smtpConfigured } from "@/lib/config";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ask to move the account to a different address, or re-send the confirmation
 * for the current one.
 *
 * NOTHING CHANGES HERE. The route writes a token and sends a mail; the address
 * on the user row moves only when the link in that mail is opened. Writing the
 * new address immediately and verifying afterwards is the version that loses
 * accounts: a typo, or an attacker who borrowed a session, relocates the
 * identity to a mailbox the owner cannot read, and the owner can no longer sign
 * in or reset their way back.
 *
 * The confirmation goes to the NEW address, because the question being asked is
 * "can you read mail here". A notice also goes to the old one, because the
 * question the owner needs answered is "did I do this".
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  // Sending mail on demand to an arbitrary address is a way to use this server
  // as a spam relay, so the cap is per account and low.
  if (await isRateLimited(`email-change:acct:${user.id}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many requests. Try again in an hour." },
      { status: 429 },
    );
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  // Same rule as the forgot route: no mail server, no promise. Without SMTP the
  // confirmation link is written to a file on the server, and answering
  // "Confirmation sent" would be telling someone to go and check an inbox that
  // will never receive anything.
  //
  // The CHANGE is refused as well as the resend, and that is deliberate: the
  // new address only becomes real when its link is opened, so starting a change
  // nobody can complete would strand the account between two addresses.
  if (process.env.NODE_ENV === "production" && !smtpConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: "email_unavailable",
        error:
          "This server has no mail set up yet, so we cannot send a confirmation — " +
          "and nothing here will pretend otherwise. Your account and your address " +
          "are unchanged.",
      },
      { status: 503 },
    );
  }

  const requested = normalizeEmail(body.email);
  const target = requested || normalizeEmail(user.email);
  const isChange = target !== normalizeEmail(user.email);

  if (!isValidEmail(target)) {
    return badRequest("That does not look like an email address.");
  }

  if (isChange) {
    // Changing the address that signs you in is a credential change, so it
    // needs the credential. Re-sending a confirmation to the address already on
    // the account is not — it grants nothing the holder of this session does
    // not already have.
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    if (row?.passwordHash) {
      const password = typeof body.password === "string" ? body.password : "";
      if (!(await verifyPassword(password, row.passwordHash))) {
        return NextResponse.json(
          { error: "Enter your current password to change your address." },
          { status: 401 },
        );
      }
    }
    // A Google-only account has no password to check. The Google identity is
    // unchanged by this and still signs them in, so the address is a label
    // rather than a credential for them — the session is authority enough.

    const taken = await prisma.user.findUnique({
      where: { email: target },
      select: { id: true },
    });
    if (taken && taken.id !== user.id) {
      return NextResponse.json(
        { error: "Another account already uses that address.", code: "exists" },
        { status: 409 },
      );
    }
  }

  const { token, stub } = await issueVerification(user.id, target, isChange ? "change" : "signup");

  if (isChange) {
    // Tell the address being left. If this was not the owner, this mail is the
    // only warning they will get while the old address still works — which it
    // does until the link is opened.
    const { sendEmail } = await import("@/lib/adapters/email");
    await sendEmail({
      to: user.email,
      subject: "Someone asked to change your Grindly address",
      body:
        `A request was made to move this Grindly account to ${target}.\n\n` +
        "Nothing has changed yet. The move happens only when the link sent to " +
        "that address is opened.\n\n" +
        "If this was not you, change your password now — whoever did it was " +
        "signed in as you.",
    }).catch(() => null);
  }

  await audit(user.id, isChange ? "email_change_requested" : "email_verify_requested", target);

  // The same three conditions the forgot-password route uses before it will put
  // a token in a response body. `stub` alone is not enough: sendEmail falls back
  // to the outbox on ANY SMTP error, so expired credentials on a production box
  // would otherwise turn this into "POST an address, receive its confirmation
  // link". A misconfigured deployment must fail closed.
  const canRevealLink = process.env.NODE_ENV !== "production" && !smtpConfigured() && stub;

  return NextResponse.json({
    ok: true,
    pending: target,
    message: isChange
      ? `Confirm the move from the link we sent to ${target}. Until you do, your account keeps its current address.`
      : `Confirmation sent to ${target}.`,
    ...(canRevealLink ? { devLink: `/verify?token=${token}` } : {}),
  });
}

/** Remove a pending change the user has thought better of. */
export async function DELETE() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;

  try {
    await prisma.emailVerificationToken.updateMany({
      where: { userId: auth.user.id, usedAt: null },
      data: { usedAt: new Date() },
    });
  } catch (e) {
    return serverError("Could not cancel that.", `account/email: ${String(e)}`);
  }

  await audit(auth.user.id, "email_change_cancelled");
  return NextResponse.json({ ok: true });
}
