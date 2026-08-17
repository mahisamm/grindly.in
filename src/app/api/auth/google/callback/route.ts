import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { baseUrl } from "@/lib/baseUrl";
import { loginClient, exchangeCode, fetchProfile } from "@/lib/googleOAuth";
import { setUid } from "@/lib/session";
import { isRateLimitedByIp } from "@/lib/rateLimit";
import { normalizeEmail } from "@/lib/password";
import { adminEmail } from "@/lib/config";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Google's redirect back to us.
 *
 * Every failure here redirects to /login with a readable reason rather than
 * returning JSON. A user who lands on a raw `{"error":"bad state"}` has no way
 * back and no idea what happened; the OAuth dance is a navigation, so its
 * failures have to be navigations too.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = baseUrl(url.origin);
  // A short CODE, not a sentence. The message lives on /login, so the wording
  // can change without breaking a bookmark, and a user never sees a URL bar
  // full of percent-encoded English.
  const back = (code: string) =>
    NextResponse.redirect(`${base}/login?error=${code}`);

  const error = url.searchParams.get("error");
  // The user pressed cancel on Google's screen. Not an error worth alarming
  // them about, and not worth a message.
  if (error) return NextResponse.redirect(`${base}/login`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return back("google_incomplete");

  const jar = await cookies();
  const expected = jar.get("g_oauth_state")?.value;
  jar.delete("g_oauth_state");
  // Checked BEFORE the rate limiter, deliberately. It is a string compare with
  // no I/O, so a forged callback costs us nothing and — more importantly — must
  // not be able to spend the limiter budget of the honest users sharing that IP.
  //
  // Without this check an attacker completes the OAuth dance in their own
  // browser and binds the victim's session to the attacker's Google account.
  if (!expected || !safeEqual(state, expected)) return back("google_state");

  // The callback is unauthenticated and reachable by anyone, and a code
  // exchange is an outbound HTTP call we pay for. The cap is deliberately high
  // and the window long: an entire campus or a mobile carrier can share one
  // egress IP, and a tight limit there locks out a hostel, not an attacker.
  if (await isRateLimitedByIp(req, "oauth_cb", 100, 60 * 60 * 1000)) {
    return back("rate_limited");
  }

  const client = loginClient();
  if (!client) return back("google_not_configured");

  let profile: { sub: string; email: string; name?: string; email_verified?: boolean };
  try {
    const token = await exchangeCode(code, `${base}/api/auth/google/callback`);
    profile = await fetchProfile(token);
  } catch (e) {
    console.error("[oauth] exchange failed:", e);
    return back("google_failed");
  }

  const email = normalizeEmail(profile.email);
  if (!email) return back("google_no_email");
  if (profile.email_verified === false) {
    // An unverified Google address can be one the holder does not control, so
    // accepting it would let someone claim an account by email alone.
    return back("google_unverified");
  }

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId: profile.sub }, { email }] },
    select: { id: true, googleId: true, deletedAt: true },
  });

  if (user?.deletedAt) return back("account_deleted");

  try {
    if (!user) {
      const isFirst = (await prisma.user.count()) === 0;
      user = await prisma.user.create({
        data: {
          email,
          googleId: profile.sub,
          name: profile.name?.slice(0, 80) ?? null,
          role: isFirst || (adminEmail() && email === adminEmail()) ? "admin" : "user",
        },
        select: { id: true, googleId: true, deletedAt: true },
      });
      await audit(user.id, "signup", email, "google");
    } else if (!user.googleId) {
      // The address already has a password account. Linking is the right move —
      // it is the same verified email — and it means someone who signed up with
      // a password can later use the Google button without being told their
      // account does not exist.
      await prisma.user.update({ where: { id: user.id }, data: { googleId: profile.sub } });
    }
  } catch (e) {
    console.error("[oauth] user upsert failed:", e);
    return back("account_failed");
  }

  await setUid(user.id);
  await audit(user.id, "login", email, "google");
  return NextResponse.redirect(`${base}/app`);
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
