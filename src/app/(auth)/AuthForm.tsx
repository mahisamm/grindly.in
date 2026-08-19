"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Logo } from "@/components/Brand";

/**
 * Codes the Google callback redirects with, turned into sentences here.
 *
 * The route sends a code rather than a message so the wording can change
 * without breaking a bookmarked URL, and so a failed sign-in does not leave
 * percent-encoded English in the address bar.
 */
const OAUTH_ERRORS: Record<string, string> = {
  rate_limited: "Too many sign-in attempts from your network. Try again in a little while.",
  google_state: "That sign-in attempt expired. Start again from this page.",
  google_incomplete: "Google sent us an incomplete response. Try again.",
  google_not_configured: "Google sign-in is not set up on this server. Use your email and password.",
  google_failed: "Google did not complete the sign-in. Try again.",
  google_no_email: "Google did not share an email address with us.",
  google_unverified: "Verify your email address with Google first, then sign in.",
  account_deleted: "That account has been deleted.",
  account_failed: "We could not finish setting up your account. Try again.",
};

/**
 * Sign in / sign up, sharing one component because they differ by three strings
 * and one endpoint.
 *
 * The Google button renders only when the server has the credentials. That
 * comes in as a prop evaluated per-request on the server — not a NEXT_PUBLIC_
 * build-time variable, which would bake the answer into the image and keep the
 * button hidden forever after an operator set the key.
 */
export function AuthForm({
  mode,
  googleAuth,
}: {
  mode: "login" | "signup";
  /**
   * Whether this server has Google OAuth configured.
   *
   * Passed in from the server component rather than fetched from /api/me on
   * mount. Fetching it meant the Google button appeared a beat after the rest
   * of the form — a layout shift on every visit, and on a slow connection a
   * window where the page offers only the password field. That is the primary
   * sign-in method for every existing account here, so it must be in the first
   * byte of HTML, not in a follow-up request.
   */
  googleAuth: boolean;
}) {
  const params = useSearchParams();
  const isSignup = mode === "signup";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // An unrecognised code renders nothing rather than echoing whatever was in
  // the query string — that parameter is attacker-controlled and printing it
  // verbatim is a text-injection footgun on the one page people trust most.
  const oauthError = OAUTH_ERRORS[params.get("error") ?? ""] ?? null;
  const [error, setError] = useState<string | null>(oauthError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isSignup
            ? { email, password, name, timezone: browserTimezone() }
            : { email, password, timezone: browserTimezone() },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work. Try again.");
        setBusy(false);
        return;
      }
      // A full navigation, not router.push: the session cookie was just set and
      // every server component needs to re-render against it.
      window.location.href = "/app";
    } catch {
      setError("We could not reach the server. Check your connection.");
      setBusy(false);
    }
  }

  return (
    <div className="animate-in relative z-[1] w-full max-w-[430px] min-w-0 px-5 py-12">
      {/* The brand panel carries the logo on desktop; on a phone that panel is
          hidden, so the form has to introduce itself.
          Left-aligned, not centred: everything else in this column starts on
          the same axis, and a centred logo above left-aligned text was the
          single most visible thing wrong with this page. One column, one edge. */}
      <Link href="/" className="mb-8 inline-flex lg:hidden">
        <Logo size={34} />
      </Link>

      <div
        className="bg-surface rounded-lg border p-6 sm:p-8"
        style={{
          borderColor: "var(--line-2)",
          // Themed, because the old value was a near-black offset shadow that
          // simply vanished against the dark ground.
          boxShadow: "8px 8px 0 var(--shadow-hard)",
        }}
      >
        <h1 className="font-display text-[1.75rem] leading-tight font-bold sm:text-3xl">
          {isSignup ? "Create your account" : "Welcome back"}
        </h1>
        <p className="text-muted mt-2 text-sm leading-relaxed">
          {isSignup
            ? "Your first resume, the full readiness report and one company pack are free."
            : "Sign in to pick up where you left off."}
        </p>

        {/* Said here, before the password field, and not for the first time on
            /pending. Signing someone up and only then telling them a person has
            to let them in is the kind of surprise that reads as a bait — and it
            is a surprise we can remove with one sentence, on the screen where
            they are still deciding. Sign-in does not carry it: an account that
            already exists finds out from the page it lands on, and repeating it
            to approved users on every sign-in would be noise. */}
        {isSignup && (
          <p
            className="mt-4 rounded-lg border px-3 py-2.5 text-xs leading-relaxed"
            style={{ borderColor: "var(--line-2)", background: "var(--surface-2)" }}
          >
            Grindly is in a <b>closed beta</b>. You can create an account now; someone
            approves it by hand before you can upload, usually the same day.
          </p>
        )}

      {googleAuth && (
        <>
          <a
            href="/api/auth/google"
            className="press mt-7 flex w-full items-center justify-center gap-2.5 rounded-full border px-4 py-3.5 font-semibold transition"
            style={{ borderColor: "var(--line-2)", background: "var(--paper)" }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path d="M47.532 24.552c0-1.636-.132-3.2-.388-4.704H24.48v8.896h12.956c-.568 2.952-2.22 5.456-4.692 7.132v5.912h7.572c4.432-4.072 6.988-10.072 6.988-17.236z" fill="#4285F4" />
              <path d="M24.48 48c6.48 0 11.916-2.148 15.888-5.812l-7.572-5.912c-2.148 1.44-4.896 2.288-8.316 2.288-6.396 0-11.82-4.32-13.748-10.128H2.9v6.1C6.856 42.86 15.088 48 24.48 48z" fill="#34A853" />
              <path d="M10.732 28.436A14.4 14.4 0 0 1 9.9 24c0-1.54.264-3.036.732-4.436v-6.1H2.9A23.952 23.952 0 0 0 .48 24c0 3.864.924 7.524 2.42 10.536l8.332-6.1z" fill="#FBBC05" />
              <path d="M24.48 9.552c3.604 0 6.836 1.24 9.38 3.672l6.972-6.972C36.388 2.352 30.96 0 24.48 0 15.088 0 6.856 5.14 2.9 13.464l7.832 6.1C12.66 13.872 18.084 9.552 24.48 9.552z" fill="#EA4335" />
            </svg>
            Continue with Google
          </a>
          <div className="my-5 flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted font-mono text-[10px] tracking-[0.14em] uppercase">or</span>
            <span className="bg-border h-px flex-1" />
          </div>
        </>
      )}

        <form onSubmit={submit} className={googleAuth ? "" : "mt-7"} noValidate>
        {isSignup && (
          <label className="mb-4 block">
            <span className="mb-1.5 block text-sm font-medium">Name</span>
            <input
              type="text"
              value={name}
              autoComplete="name"
              onChange={(e) => setName(e.target.value)}
              className="field w-full"
              placeholder="Priya Sharma"
            />
          </label>
        )}

        <label className="mb-4 block">
          <span className="mb-1.5 block text-sm font-medium">Email</span>
          <input
            type="email"
            required
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            className="field w-full"
            placeholder="you@example.com"
          />
        </label>

        <label className="block">
          {/* The label row carries "Forgot your password?" on its right.
              It used to sit on its own line below the submit button, where it
              was an orphan between two paragraphs and read as a third piece of
              body copy rather than an action. Beside the field it labels is
              both the convention and the place someone looks for it. */}
          <span className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">Password</span>
            {!isSignup && (
              <Link href="/forgot" className="text-muted hover:text-ink text-xs">
                Forgot your password?
              </Link>
            )}
          </span>
          <input
            type="password"
            required
            value={password}
            autoComplete={isSignup ? "new-password" : "current-password"}
            onChange={(e) => setPassword(e.target.value)}
            className="field w-full"
            placeholder={isSignup ? "At least 10 characters" : ""}
          />
          {isSignup && (
            <span className="text-muted mt-1.5 block text-xs">
              Ten characters or more. Length beats symbols.
            </span>
          )}
        </label>

        {error && (
          <p
            role="alert"
            className="mt-4 rounded-lg border p-3 text-sm"
            style={{ borderColor: "#a3271b", color: "#a3271b" }}
          >
            {error}
          </p>
        )}

          <button type="submit" disabled={busy} className="btn btn-primary mt-6 w-full justify-center">
          {busy ? "Working…" : isSignup ? "Create account" : "Sign in"}
        </button>
      </form>

        {/* One rule, then one line. The card used to end with a link and two
            paragraphs at three different sizes, which gave it a ragged bottom
            edge and no clear last action. */}
        <p className="border-border text-muted mt-6 border-t pt-5 text-sm">
          {isSignup ? (
            <>
              Already have an account?{" "}
              <Link href="/login" className="text-brand font-medium underline">
                Sign in
              </Link>
            </>
          ) : (
            <>
              No account yet?{" "}
              <Link href="/signup" className="text-brand font-medium underline">
                Create one
              </Link>
            </>
          )}
        </p>
      </div>

      {/* Outside the card, and lighter. It is a standing promise rather than a
          step in signing in, and inside the card it competed with the button. */}
      <p className="text-muted mt-6 px-1 text-xs leading-relaxed">
        Your resume and what we measure from it stay yours — we do not sell it, we do
        not train models on it, and you can delete everything from your account page.{" "}
        <Link href="/privacy" className="hover:text-ink underline">
          Privacy
        </Link>{" "}
        ·{" "}
        <Link href="/terms" className="hover:text-ink underline">
          Terms
        </Link>
      </p>
    </div>
  );
}

/**
 * The browser's IANA timezone, or null if it will not say.
 *
 * Sent on sign-in as well as sign-up, so an account created before this existed
 * gets its zone the next time its owner signs in rather than staying on the
 * default forever. Daily quotas are counted in the user's own day (lib/quota.ts)
 * and the refusal message promises the limit resets at midnight in their
 * timezone — which was true only for the half of the audience in IST.
 *
 * Not sensitive, and not a fingerprint we did not already have: it is one of the
 * first things any server can infer from a request.
 */
function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
