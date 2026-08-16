/**
 * Google sign-in: just enough OAuth to identify someone.
 *
 * This file used to be mostly Gmail scaffolding — readonly and send scopes,
 * beta allow-lists, and switches for a feature gated behind Google's restricted
 * scope review that never shipped. All of that went with the auto-apply build.
 * What is left asks for `openid email profile` and nothing else, which matters:
 * a sensitive or restricted scope on this client would put the entire login
 * flow behind Google verification, and login is one of only two doors in.
 */

export type OAuthClient = { clientId: string; clientSecret: string };

export function loginClient(): OAuthClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Timeout on every outbound call — Google being slow must not hold a request open. */
const TIMEOUT_MS = 10_000;

async function postForm(url: string, body: URLSearchParams): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** Swap the one-time code for an access token. Throws with a readable message. */
export async function exchangeCode(code: string, redirectUri: string): Promise<string> {
  const client = loginClient();
  if (!client) throw new Error("Google OAuth is not configured");

  const res = await postForm(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      code,
      client_id: client.clientId,
      client_secret: client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("token exchange returned no access token");
  return data.access_token;
}

export type GoogleProfile = {
  sub: string;
  email: string;
  name?: string;
  email_verified?: boolean;
};

/**
 * Read the profile behind an access token.
 *
 * `email_verified` is returned rather than discarded because the caller must
 * refuse an unverified address: Google will hand out a profile for an email the
 * holder has not proven they own, and accepting it would let someone claim an
 * existing account by address alone.
 */
export async function fetchProfile(accessToken: string): Promise<GoogleProfile> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`profile fetch failed (${res.status})`);
  }
  const data = (await res.json()) as Partial<GoogleProfile>;
  if (!data.sub || !data.email) throw new Error("profile response was incomplete");
  return {
    sub: String(data.sub),
    email: String(data.email),
    name: data.name ? String(data.name) : undefined,
    email_verified: data.email_verified,
  };
}
