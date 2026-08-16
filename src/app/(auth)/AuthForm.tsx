"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
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
 * The Google button is rendered only when the server says the credentials
 * exist. That check comes from /api/me at runtime rather than from a
 * NEXT_PUBLIC_ build-time variable, because a Docker image built without the
 * key would otherwise keep hiding the button forever after an operator sets it.
 */
export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
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
  const [googleAuth, setGoogleAuth] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        setGoogleAuth(Boolean(d?.server?.googleAuth));
        // Already signed in — do not show a login form to someone who is.
        if (d?.user) router.replace("/app");
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isSignup ? { email, password, name } : { email, password }),
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
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-10 inline-flex">
        <Logo />
      </Link>

      <h1 className="font-display text-3xl font-bold">
        {isSignup ? "Create your account" : "Welcome back"}
      </h1>
      <p className="text-muted mt-2 text-sm">
        {isSignup
          ? "Your first resume, the full readiness report and one company pack are free."
          : "Sign in to pick up where you left off."}
      </p>

      {googleAuth && (
        <>
          <a href="/api/auth/google" className="btn mt-8 w-full justify-center">
            Continue with Google
          </a>
          <div className="my-6 flex items-center gap-3">
            <span className="bg-border h-px flex-1" />
            <span className="text-muted font-mono text-[10px] tracking-[0.14em] uppercase">or</span>
            <span className="bg-border h-px flex-1" />
          </div>
        </>
      )}

      <form onSubmit={submit} className={googleAuth ? "" : "mt-8"} noValidate>
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
            placeholder="you@college.edu.in"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Password</span>
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

      {!isSignup && (
        <Link href="/forgot" className="text-muted hover:text-ink mt-4 text-sm">
          Forgot your password?
        </Link>
      )}

      <p className="text-muted mt-8 text-sm">
        {isSignup ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="text-brand underline">Sign in</Link>
          </>
        ) : (
          <>
            No account yet?{" "}
            <Link href="/signup" className="text-brand underline">Create one</Link>
          </>
        )}
      </p>
    </main>
  );
}
