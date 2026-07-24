import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { audit } from "@/lib/audit";
import { baseUrl } from "@/lib/baseUrl";
import { loginClient } from "@/lib/googleOAuth";
import { DEFAULTS } from "@/lib/proffQuestions";
import { isRateLimited, getIp } from "@/lib/rateLimit";
import { resolveInitialAccess, hasAppAccess, signupPausedFor } from "@/lib/access";
import { readAdminSettings, isEmailDomainBanned } from "@/lib/adminSettings";

interface GoogleTokenResponse {
  access_token: string;
  error?: string;
}

interface GoogleUserInfo {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean | string;
}

function statesMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = baseUrl(url.origin);
  // Every *handled* failure below redirects cleanly to /login?error=…. This outer
  // guard catches the UNhandled ones — a network blip to Google's token/userinfo
  // endpoints, or a DB hiccup during create/find/update — so the one path every
  // user hits first degrades to a clean "try again" redirect instead of a raw 500.
  try {
    return await handleGoogleCallback(req, url, base);
  } catch (e) {
    console.error("[google-callback] unexpected failure:", e);
    return NextResponse.redirect(`${base}/login?error=google_failed`);
  }
}

async function handleGoogleCallback(req: Request, url: URL, base: string) {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const returnedState = url.searchParams.get("state");

  if (error || !code) {
    return NextResponse.redirect(`${base}/login?error=google_denied`);
  }

  const settings = readAdminSettings();
  if (!settings.featureFlags.googleAuth) {
    return NextResponse.redirect(`${base}/login?error=google_disabled`);
  }

  // CSRF: the state echoed by Google must match the cookie we set in the
  // initiator. Consume the cookie either way so it can't be replayed.
  const c = await cookies();
  const savedState = c.get("g_oauth_state")?.value;
  c.delete("g_oauth_state");
  if (!returnedState || !savedState || !statesMatch(returnedState, savedState)) {
    return NextResponse.redirect(`${base}/login?error=google_state`);
  }

  // Per-IP cap on completed OAuth callbacks. The CSRF state above stops junk
  // hits, but a valid-state flood — or one host spinning up many accounts from
  // many Google identities — is still capped here. Kept high (100/hr) because the
  // target audience (Indian students) shares public IPs heavily via mobile-carrier
  // CGNAT and campus/college NAT: dozens of distinct real users can front the same
  // IP, so a tight cap would lock out whole clusters of legitimate logins. This is
  // only an anti-churn backstop, not the primary abuse control (CSRF state is).
  const ip = getIp(req);
  if (await isRateLimited(`oauth_cb:${ip}`, 100, 60 * 60 * 1000)) {
    return NextResponse.redirect(`${base}/login?error=rate_limited`);
  }

  const client = loginClient();
  if (!client) {
    return NextResponse.redirect(`${base}/login?error=google_not_configured`);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: `${base}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json() as GoogleTokenResponse;
  if (!tokenRes.ok || !tokens.access_token) {
    return NextResponse.redirect(`${base}/login?error=google_token`);
  }

  const infoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!infoRes.ok) {
    return NextResponse.redirect(`${base}/login?error=google_userinfo`);
  }

  const { sub: googleId, email, name, email_verified } = await infoRes.json() as GoogleUserInfo;
  if (!email) {
    return NextResponse.redirect(`${base}/login?error=google_no_email`);
  }
  const verified = email_verified === true || email_verified === "true";

  let user = await prisma.user.findFirst({
    where: { OR: [{ googleId }, { email }] },
  });

  // Require a Google-verified email before creating an account OR linking this
  // Google identity to a pre-existing (e.g. password) account by email —
  // otherwise an unverified Google email could take over a matching account.
  const needsVerifiedEmail = !user || user.googleId !== googleId;
  if (needsVerifiedEmail && !verified) {
    return NextResponse.redirect(`${base}/login?error=google_unverified`);
  }

  if (!user) {
    if (isEmailDomainBanned(email, settings)) {
      return NextResponse.redirect(`${base}/login?error=domain_banned`);
    }
    // Sign-ups paused. This is the only point where a new account can be told
    // apart from a returning one — /login and /signup are the same Google
    // button, and the email only exists after the round-trip — so the gate has
    // to live here, before the create, rather than on the page.
    //
    // The owner is always exempt. With no account of their own they would
    // otherwise be locked out by the very switch they turned on, and there is
    // no second way in.
    if (signupPausedFor(email, settings.signupMaintenance)) {
      return NextResponse.redirect(`${base}/signup`);
    }
    // Owner + pre-allowlisted emails come in approved; everyone else waits.
    const accessStatus = await resolveInitialAccess(email);
    try {
      user = await prisma.user.create({
        data: {
          email,
          name: name ?? null,
          googleId,
          status: "onboarding",
          accessStatus,
          accessGrantedAt: accessStatus === "approved" ? new Date() : null,
          profile: {
            create: {
              skills: "[]",
              preferredDomains: JSON.stringify(DEFAULTS.preferredDomains),
              preferredLocations: JSON.stringify(DEFAULTS.preferredLocations),
              workMode: DEFAULTS.workMode as string,
              experienceLevel: DEFAULTS.experienceLevel as string,
              stipendMin: DEFAULTS.stipendMin as number,
              minMatchScore: DEFAULTS.minMatchScore as number,
              maxPerDay: DEFAULTS.maxPerDay as number,
              excludedCompanies: JSON.stringify(DEFAULTS.excludedCompanies),
              autoApply: DEFAULTS.autoApply as boolean,
            },
          },
        },
      });
      await audit("register_google", { userId: user.id, target: email });
    } catch (e) {
      // Two concurrent first-logins (double-submit / provider retry) can race the
      // create on the unique email/googleId; the loser gets Prisma P2002. Recover
      // by loading the row the winner just created, instead of 500ing the user on
      // their very first login.
      if ((e as { code?: string })?.code !== "P2002") throw e;
      user = await prisma.user.findFirst({ where: { OR: [{ googleId }, { email }] } });
    }
  } else {
    if (!user.googleId) {
      await prisma.user.update({ where: { id: user.id }, data: { googleId } });
    }
    await audit("login_google", { userId: user.id, target: email });
  }

  if (!user) {
    // P2002 recovery lookup came back empty (should never happen) — fail safe
    // rather than dereference null.
    return NextResponse.redirect(`${base}/login?error=google_failed`);
  }

  await setUid(user.id);

  // Gated beta: an unapproved account can sign in but only reaches the waitlist,
  // never onboarding or the dashboard, until an admin approves it.
  if (!hasAppAccess(user)) {
    return NextResponse.redirect(`${base}/waitlist`);
  }

  // Owner admin gets a fork on EVERY login — enter the user app OR the admin
  // console. Same double gate as lib/admin.ts (role + email must both match),
  // so only the real owner ever sees /choose; /choose itself re-checks and
  // bounces anyone else to /dashboard. Shown even mid-onboarding — the owner
  // can jump to the console and finish onboarding later.
  const isOwnerAdmin =
    user.role === "admin" &&
    !!process.env.ADMIN_EMAIL &&
    user.email === process.env.ADMIN_EMAIL;
  if (isOwnerAdmin) {
    return NextResponse.redirect(`${base}/choose`);
  }

  return NextResponse.redirect(
    `${base}${user.status === "onboarding" ? "/onboarding" : "/dashboard"}`
  );
}
