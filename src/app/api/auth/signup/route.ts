import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { isRateLimitedByIp } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";
import { isValidTimezone } from "@/lib/quota";
import { adminEmail } from "@/lib/config";
import {
  hashPassword,
  isValidEmail,
  normalizeEmail,
  validatePassword,
} from "@/lib/password";

/**
 * Create an account with an email and a password.
 *
 * Two limits, deliberately different in kind: a burst limit per IP (someone
 * scripting account creation) and nothing at all per email, because the unique
 * index already makes duplicate signups a no-op. Rate-limiting by email would
 * let an attacker lock a known address out of ever registering.
 */
export async function POST(req: Request) {
  // 40/hour, not 10. Behind CGNAT or on a campus network an entire cohort
  // shares one egress IP, and a signup cap tight enough to stop a script also
  // stops a classroom. The account-level guards below (unique email, password
  // rules) are what actually bound abuse; this only bounds volume.
  if (await isRateLimitedByIp(req, "signup", 40, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many accounts created from here. Try again in an hour." },
      { status: 429 },
    );
  }

  let body: { email?: string; password?: string; name?: string; timezone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send a JSON body." }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  // Narrowed here rather than cast later: a non-string becomes "", which
  // fails the length rule and produces the same message a two-character
  // password gets. `validatePassword` guards this too, for callers that
  // do not narrow first.
  const password = typeof body.password === "string" ? body.password : "";
  const name = (body.name ?? "").trim().slice(0, 80) || null;

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "That does not look like an email address." }, { status: 400 });
  }
  const passwordProblem = validatePassword(password);
  if (passwordProblem) {
    return NextResponse.json({ error: passwordProblem }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    // Deliberately explicit rather than a generic "could not sign up". Email
    // enumeration is a real concern on products where membership is sensitive;
    // on a resume tool it is not, and the cost of hiding it is every user who
    // already has an account being told "something went wrong" instead of "you
    // already have an account — sign in".
    return NextResponse.json(
      { error: "An account with that email already exists. Sign in instead.", code: "exists" },
      { status: 409 },
    );
  }

  const passwordHash = await hashPassword(password);
  // The very first account, or one matching ADMIN_EMAIL, is an admin. Without
  // this there is no way to reach the admin surface on a fresh deployment
  // except by editing the database by hand.
  const isFirst = (await prisma.user.count()) === 0;
  const role = isFirst || (adminEmail() && email === adminEmail()) ? "admin" : "user";

  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash,
        role,
        // Validated, not trusted: this comes off a request body, and an
        // unusable zone stored here makes every later quota check for this one
        // account throw. Null when the browser would not say — quota.ts falls
        // back to the default rather than guessing.
        timezone: isValidTimezone(body.timezone) ? body.timezone : null,
      },
      select: { id: true, email: true, name: true, role: true },
    });
  } catch (e) {
    // A concurrent signup with the same address loses the unique-index race.
    console.error("[signup] create failed:", e);
    return NextResponse.json(
      { error: "Could not create the account. Try signing in." },
      { status: 409 },
    );
  }

  await setUid(user.id);
  await audit(user.id, "signup", email);
  return NextResponse.json({ ok: true, user });
}
