import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { isRateLimited, isRateLimitedByIp } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";
import { normalizeEmail, verifyPassword } from "@/lib/password";

/**
 * Sign in with an email and a password.
 *
 * Both failure paths — no such user, wrong password — return the same message
 * and take roughly the same time. The timing half matters: returning early on
 * an unknown email makes the response measurably faster than one that ran
 * scrypt, which turns the endpoint into an account-existence oracle even with
 * identical wording. So an unknown email still pays for a verify against a
 * throwaway hash.
 */

// A real scrypt hash of a value nobody has. Verifying against it costs the same
// as verifying a genuine one, which is the entire point.
const DUMMY_HASH =
  "scrypt$32768$8$1$00000000000000000000000000000000$" + "0".repeat(128);

export async function POST(req: Request) {
  // Loose per IP, because that bucket can be shared by a whole campus. It is
  // also SKIPPED ENTIRELY when there is no trustworthy address — see
  // isRateLimitedByIp. The tight limit that actually stops password guessing is
  // the per-account one below, which no amount of IP rotation can dodge and
  // which cannot be used to lock a third party out.
  if (await isRateLimitedByIp(req, "login", 100, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many sign-in attempts. Wait fifteen minutes and try again." },
      { status: 429 },
    );
  }

  let body: { email?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  const password = body.password ?? "";
  if (!email || !password) {
    return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
  }

  // A per-account limit on top of the per-IP one: without it, a botnet spreads
  // a password-guessing run across enough addresses that no IP bucket ever
  // fills, and one account absorbs unlimited attempts.
  if (await isRateLimited(`login:acct:${email}`, 12, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many sign-in attempts for this account. Wait fifteen minutes." },
      { status: 429 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, role: true, passwordHash: true, deletedAt: true },
  });

  const live = user && !user.deletedAt ? user : null;

  // Always run a verify, including for an unknown address, so the response time
  // does not disclose whether the account exists.
  const ok = await verifyPassword(password, live?.passwordHash || DUMMY_HASH);

  // This check must come BEFORE the generic failure, not after it. Placed after,
  // it is unreachable: a Google-only account has no hash, so `ok` is already
  // false and the generic branch returns first — leaving the user to reset a
  // password that was never set, forever.
  if (live && !live.passwordHash) {
    return NextResponse.json(
      { error: "This account signs in with Google. Use the Google button above.", code: "google_only" },
      { status: 401 },
    );
  }

  if (!ok || !live) {
    if (live) await audit(live.id, "login_failed", email);
    return NextResponse.json({ error: "That email and password do not match." }, { status: 401 });
  }
  const found = live;

  await setUid(found.id);
  await audit(found.id, "login", email);
  return NextResponse.json({
    ok: true,
    user: { id: found.id, email: found.email, name: found.name, role: found.role },
  });
}
