import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { getUid } from "@/lib/session";
import { baseUrl } from "@/lib/baseUrl";
import { prisma } from "@/lib/prisma";
import { gmailClient, gmailConnectBeta, gmailScopes } from "@/lib/googleOAuth";

function signState(uid: string, ts: number): string {
  const key = process.env.APP_ENCRYPTION_KEY ?? "";
  const mac = createHmac("sha256", key).update(`${uid}:${ts}`).digest("hex");
  return `${uid}.${ts}.${mac}`;
}

// Initiates Gmail OAuth against the Gmail client (NOT the login client — see
// src/lib/googleOAuth.ts). Requests whichever Gmail capabilities the deploy has
// switched on — gmail.readonly for interview detection, gmail.send so the agent
// can mail applications to HR mailboxes from the user's own address — plus
// offline access so we get a refresh_token to store.
// state = uid.timestamp.HMAC — verified in callback to prevent CSRF.
export async function GET(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.redirect(new URL("/login", req.url));

  const base = baseUrl(new URL(req.url).origin);

  // Both Gmail scopes are restricted. Until they clear verification, only
  // allowlisted beta testers (also added as Google test users) can complete this
  // consent — everyone else hits a warning or a hard block. Gate on the per-user
  // beta check, not just the env switch, so a non-tester who reaches this URL
  // directly is turned away at the door instead of at Google's wall.
  const user = await prisma.user.findUnique({ where: { id: uid }, select: { email: true } });
  if (!gmailConnectBeta(user?.email)) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=unavailable`);
  }

  const scopes = gmailScopes();
  if (scopes.length === 0) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=unavailable`);
  }

  const client = gmailClient()!;
  const state = signState(uid, Date.now());

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: `${base}/api/auth/gmail/callback`,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    { status: 302 }
  );
}
