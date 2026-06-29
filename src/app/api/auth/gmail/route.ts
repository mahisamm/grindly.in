import { NextResponse } from "next/server";
import { createHmac } from "node:crypto";
import { getUid } from "@/lib/session";

function signState(uid: string, ts: number): string {
  const key = process.env.APP_ENCRYPTION_KEY ?? "";
  const mac = createHmac("sha256", key).update(`${uid}:${ts}`).digest("hex");
  return `${uid}.${ts}.${mac}`;
}

// Initiates Gmail read-only OAuth. Separate from login OAuth — requests
// gmail.readonly + offline access so we get a refresh_token to store.
// state = uid.timestamp.HMAC — verified in callback to prevent CSRF.
export async function GET(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.redirect(new URL("/login", req.url));

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json({ error: "Google OAuth not configured" }, { status: 503 });
  }

  const base = new URL(req.url).origin;
  const state = signState(uid, Date.now());

  const params = new URLSearchParams({
    client_id: clientId,
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
