import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { baseUrl } from "@/lib/baseUrl";
import { loginClient } from "@/lib/googleOAuth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const client = loginClient();
  if (!client) {
    return NextResponse.json({ error: "Google OAuth not configured" }, { status: 503 });
  }

  const base = baseUrl(new URL(req.url).origin);

  // CSRF protection: random state echoed back by Google and matched against an
  // httpOnly cookie in the callback. Without it an attacker can complete OAuth
  // and bind the victim's browser to the attacker's Google account.
  const state = randomBytes(16).toString("hex");
  const c = await cookies();
  c.set("g_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 min
    secure: process.env.NODE_ENV === "production",
  });

  // Non-sensitive scopes only — keep it that way. Adding a sensitive or
  // restricted scope here puts the login flow behind Google verification.
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: `${base}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    { status: 302 }
  );
}
