// Login and Gmail deliberately use SEPARATE Google OAuth clients.
//
// Login asks for openid/email/profile — "non-sensitive" scopes that Google
// serves to the public with no verification at all. Gmail scanning asks for
// gmail.readonly, which Google classes as RESTRICTED: any GCP project that
// registers it must pass full verification (including a CASA security
// assessment, a multi-week process) before it may serve anyone outside its
// test-user list.
//
// Publishing status is per-project, so a single shared client would drag the
// only way into the app behind that review — exactly the "Access blocked:
// has not completed the Google verification process" wall. Keeping the clients
// separate lets the login project publish today while the Gmail project
// verifies on its own timeline.
//
// GMAIL_CLIENT_ID/SECRET unset falls back to the login client, which is correct
// for local dev and for a single-project setup still in Testing mode.

export type OAuthClient = { clientId: string; clientSecret: string };

export function loginClient(): OAuthClient | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function gmailClient(): OAuthClient | null {
  const clientId = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Gmail scanning stays off unless explicitly switched on. Until gmail.readonly
 *  clears Google verification, sending a user into that consent flow either
 *  shows a full-page "Google hasn't verified this app" warning or is refused
 *  outright — so the dashboard hides the entry point rather than offering a
 *  button that leads to a wall. */
export function gmailScanEnabled(): boolean {
  return process.env.GMAIL_SCAN_ENABLED === "1" && !!gmailClient();
}
