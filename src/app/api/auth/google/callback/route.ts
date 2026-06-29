import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { audit } from "@/lib/audit";
import { baseUrl } from "@/lib/baseUrl";
import { DEFAULTS } from "@/lib/proffQuestions";

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
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const returnedState = url.searchParams.get("state");

  if (error || !code) {
    return NextResponse.redirect(`${base}/login?error=google_denied`);
  }

  // CSRF: the state echoed by Google must match the cookie we set in the
  // initiator. Consume the cookie either way so it can't be replayed.
  const c = await cookies();
  const savedState = c.get("g_oauth_state")?.value;
  c.delete("g_oauth_state");
  if (!returnedState || !savedState || !statesMatch(returnedState, savedState)) {
    return NextResponse.redirect(`${base}/login?error=google_state`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return NextResponse.redirect(`${base}/login?error=google_not_configured`);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
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
    user = await prisma.user.create({
      data: {
        email,
        name: name ?? null,
        googleId,
        status: "onboarding",
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
  } else {
    if (!user.googleId) {
      await prisma.user.update({ where: { id: user.id }, data: { googleId } });
    }
    await audit("login_google", { userId: user.id, target: email });
  }

  await setUid(user.id);

  return NextResponse.redirect(
    `${base}${user.status === "onboarding" ? "/onboarding" : "/dashboard"}`
  );
}
