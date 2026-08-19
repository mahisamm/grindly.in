import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { isRateLimited, isRateLimitedByIp } from "@/lib/rateLimit";
import { normalizeEmail } from "@/lib/password";
import { sendEmail } from "@/lib/adapters/email";
import { appUrl, smtpConfigured } from "@/lib/config";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a reset link works. Short, because it is a bearer credential. */
const TTL_MS = 45 * 60 * 1000;

/**
 * Start a password reset.
 *
 * Always answers 200 with the same body, whether or not the address exists.
 * The alternative turns this endpoint into a membership oracle for anyone with
 * a list of emails — and unlike signup, where telling someone "you already have
 * an account" is genuinely helpful, there is nothing useful to say here.
 *
 * Without this route a user who forgot their password on a deployment with no
 * Google OAuth was permanently locked out, with no recovery path at all.
 */
export async function POST(req: Request) {
  if (await isRateLimitedByIp(req, "forgot", 30, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many reset requests. Try again later." },
      { status: 429 },
    );
  }

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  // No mail server, no promise.
  //
  // In production without SMTP, `sendEmail` writes to a file on the server and
  // reports success, and this route answered "a reset link is on its way" —
  // which is untrue, and untrue in the one place a user has no way to check. A
  // product that opens by refusing to quote a number no system computes cannot
  // then tell someone their mail is coming when it is not.
  //
  // Answered BEFORE the account lookup on purpose: this is a fact about the
  // server, not about whether the address is registered, so it cannot become an
  // account-existence oracle.
  if (process.env.NODE_ENV === "production" && !smtpConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: "email_unavailable",
        error:
          "This server has no mail set up yet, so we cannot send you a reset link — " +
          "and telling you one was on its way would be a lie. If you signed in with " +
          "Google, use the Google button. Otherwise contact whoever runs this site.",
      },
      { status: 503 },
    );
  }

  const email = normalizeEmail(body.email);
  const sameAnswer = NextResponse.json({
    ok: true,
    message: "If that address has an account, a reset link is on its way.",
  });
  if (!email) return sameAnswer;

  // Per-account cap on top of the per-IP one, so one address cannot be used to
  // flood someone's inbox from a rotating set of IPs.
  if (await isRateLimited(`forgot:acct:${email}`, 5, 60 * 60 * 1000)) return sameAnswer;

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, passwordHash: true, deletedAt: true },
  });
  if (!user || user.deletedAt) return sameAnswer;

  if (!user.passwordHash) {
    // A Google-only account has no password to reset. Say so in the mail rather
    // than sending a link that would silently create one — anyone who gained
    // read access to that inbox could otherwise convert an OAuth account into a
    // password account they control.
    await sendEmail({
      to: email,
      subject: "Grindly: this account signs in with Google",
      body:
        "Someone asked to reset the password for this address.\n\n" +
        "This account signs in with Google, so it has no password. Use the " +
        "'Continue with Google' button on the sign-in page.\n\n" +
        "If this was not you, you can ignore this message.",
    });
    return sameAnswer;
  }

  // Invalidate anything outstanding. Two live links means an old one, possibly
  // already exposed, still works after the user asked for a fresh one.
  await prisma.passwordResetToken
    .updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    })
    .catch(() => null);

  const token = randomBytes(32).toString("base64url");
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      expiresAt: new Date(Date.now() + TTL_MS),
    },
  });

  const link = `${appUrl()}/reset?token=${token}`;
  const delivery = await sendEmail({
    to: email,
    subject: "Reset your Grindly password",
    body:
      `Open this link to choose a new password:\n\n${link}\n\n` +
      `It works once and expires in ${Math.round(TTL_MS / 60000)} minutes.\n\n` +
      "If you did not ask for this, ignore it — your password has not changed.",
  });

  await audit(user.id, "password_reset_requested", email);

  // Returning the link to the caller is a full account-takeover primitive, so
  // it is gated on THREE independent conditions, all of which must hold.
  //
  // Gating on `delivery.stub` alone was the bug: `sendEmail` catches ANY SMTP
  // error and falls through to the outbox reporting `stub: true`, so expired
  // credentials or a provider outage silently turned this endpoint into
  // "POST an email address, receive a password reset for it". A misconfigured
  // production box must fail closed, not hand out keys.
  const canRevealLink =
    process.env.NODE_ENV !== "production" && !smtpConfigured() && delivery.stub;

  if (canRevealLink) {
    return NextResponse.json({
      ok: true,
      message: "No mail server is configured on this development server, so here is the link.",
      devLink: link,
    });
  }
  if (delivery.stub) {
    // SMTP is configured but did not deliver. Say so rather than claiming the
    // mail is on its way — the user would otherwise wait for something that is
    // sitting in a file on the server.
    console.error("[forgot] SMTP delivery failed; reset mail went to the outbox");
  }
  return sameAnswer;
}
