import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { encryptSecret } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { baseUrl } from "@/lib/baseUrl";
import { gmailClient } from "@/lib/googleOAuth";
import { getUid } from "@/lib/session";

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

function verifyState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [uid, tsStr, mac] = parts;
  const ts = parseInt(tsStr, 10);
  if (!uid || !ts || !mac) return null;
  if (Date.now() - ts > STATE_MAX_AGE_MS) return null;

  const key = process.env.APP_ENCRYPTION_KEY ?? "";
  const expected = createHmac("sha256", key).update(`${uid}:${ts}`).digest("hex");
  const a = Buffer.from(mac, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return uid;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const base = baseUrl(url.origin);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error || !code || !rawState) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=denied`);
  }

  const state = verifyState(rawState);
  if (!state) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=csrf`);
  }

  // The HMAC only proves *someone* who once had a session minted this state —
  // it does not prove the browser completing the flow right now is that same
  // session. Without this check, an attacker can mint a valid state for their
  // own account, hand the resulting consent URL to a victim, and have the
  // victim's Gmail refresh token stored under the attacker's Grindly account.
  const currentUid = await getUid();
  if (!currentUid || currentUid !== state) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=session_mismatch`);
  }

  // Must be the same client that issued the code in /api/auth/gmail — Google
  // rejects a token exchange whose client_id differs from the one that minted it.
  const client = gmailClient();
  if (!client) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=config`);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: `${base}/api/auth/gmail/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; error?: string };
  if (!tokenRes.ok || !tokens.refresh_token) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=token`);
  }

  // Store encrypted refresh token in PlatformCredential (platform = "gmail")
  const ciphertext = encryptSecret(JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
  }));

  await prisma.platformCredential.upsert({
    where: { userId_platform: { userId: state, platform: "gmail" } },
    create: { userId: state, platform: "gmail", ciphertext },
    update: { ciphertext },
  });

  // Mark integration connected
  await prisma.userIntegration.upsert({
    where: { userId_platform: { userId: state, platform: "gmail" } },
    create: { userId: state, platform: "gmail", status: "connected", connectedAt: new Date() },
    update: { status: "connected", connectedAt: new Date() },
  });

  await audit("gmail_connect", { userId: state });

  return NextResponse.redirect(`${base}/dashboard?gmailConnected=1`);
}
