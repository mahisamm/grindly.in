import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { getUid } from "@/lib/session";
import { baseUrl } from "@/lib/baseUrl";
import { gmailClient, gmailScanEnabled } from "@/lib/googleOAuth";

function signState(uid: string, ts: number): string {
  const key = process.env.APP_ENCRYPTION_KEY ?? "";
  const mac = createHmac("sha256", key).update(`${uid}:${ts}`).digest("hex");
  return `${uid}.${ts}.${mac}`;
}

// Initiates Gmail read-only OAuth against the Gmail client (NOT the login
// client — see src/lib/googleOAuth.ts). Requests gmail.readonly + offline
// access so we get a refresh_token to store.
// state = uid.timestamp.HMAC — verified in callback to prevent CSRF.
export async function GET(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.redirect(new URL("/login", req.url));

  const base = baseUrl(new URL(req.url).origin);

  // gmail.readonly is a restricted scope. Until it clears verification, walking
  // a user into this consent screen only shows them a warning or a hard block,
  // so refuse at the door and send them back with a message they can act on.
  if (!gmailScanEnabled()) {
    return NextResponse.redirect(`${base}/dashboard?gmailError=unavailable`);
  }

  const client = gmailClient()!;
  const state = signState(uid, Date.now());

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: `${base}/api/auth/gmail/callback`,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return NextResponse.redirect(
    `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
    { status: 302 }
  );
}
