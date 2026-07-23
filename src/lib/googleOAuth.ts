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

/** Emails cleared to use Gmail scanning while it is still in Google's Testing
 *  mode (owner + hand-picked beta testers, each also added as a Google test
 *  user). Comma-separated in GMAIL_SCAN_BETA_EMAILS, matched case-insensitively. */
export function gmailScanBetaEmails(): Set<string> {
  return new Set(
    (process.env.GMAIL_SCAN_BETA_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Whether THIS user may see the live "Connect Gmail" flow. Distinct from
 *  gmailScanEnabled(): the env switch turns the backend capability on for the
 *  fleet, but until gmail.readonly is publicly verified only allowlisted testers
 *  can complete Google's consent (everyone else hits the "unverified app" wall).
 *  So the public sees a waitlist link and only beta emails see Connect. */
export function gmailScanBeta(email: string | null | undefined): boolean {
  if (!gmailScanEnabled() || !email) return false;
  return gmailScanBetaEmails().has(email.toLowerCase());
}

/** Whether the agent may SEND application emails from the user's Gmail.
 *
 *  A large share of internship listings are cross-posts whose real intake is an
 *  HR mailbox. Mailing the application from the candidate's own address is the
 *  lowest-risk delivery channel Grindly has — no account of theirs is being
 *  automated, the recruiter gets a normal email from a real person, and replies
 *  land in their inbox where they belong.
 *
 *  Separate switch from scanning on purpose: reading someone's inbox and sending
 *  mail as them are different grants with different consequences if either is
 *  wrong, and gmail.send carries its own restricted-scope verification. Off
 *  unless the deploy says otherwise — a default-on send capability is not
 *  something a misconfigured environment should be able to hand out. Mirrored
 *  agent-side by channel_email.enabled() (GMAIL_SEND_ENABLED). */
export function gmailSendEnabled(): boolean {
  return process.env.GMAIL_SEND_ENABLED === "1" && !!gmailClient();
}

/** The scopes the Gmail consent screen asks for.
 *
 *  Requested together in one consent so the user is not sent back to Google a
 *  second time, but each half is independently gated: a token minted with send
 *  is useless while GMAIL_SEND_ENABLED is off, and vice versa. Never returns an
 *  empty list — a consent screen asking for nothing is a broken redirect, so
 *  callers must check gmailConnectBeta() before starting the flow at all. */
export function gmailScopes(): string[] {
  const scopes: string[] = [];
  if (gmailScanEnabled()) scopes.push("https://www.googleapis.com/auth/gmail.readonly");
  if (gmailSendEnabled()) scopes.push("https://www.googleapis.com/auth/gmail.send");
  return scopes;
}

/** May this user start the Gmail consent flow at all?
 *
 *  True when at least one Gmail capability is switched on for the fleet AND this
 *  email is on the beta list. Both scopes are restricted, so a non-tester who
 *  reaches the URL directly is turned away here rather than at Google's
 *  "unverified app" wall — which is a dead end with no way back. */
export function gmailConnectBeta(email: string | null | undefined): boolean {
  if (!email) return false;
  if (!gmailScanEnabled() && !gmailSendEnabled()) return false;
  return gmailScanBetaEmails().has(email.toLowerCase());
}
