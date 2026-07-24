"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { Target, Bolt, Slack, Shield } from "@/components/Doodles";

// Beta: Google is the only sign-in method. Email/password + phone-OTP backend
// routes still exist but are intentionally not exposed here (no SMS provider
// needed to launch). Re-add the form to bring them back.
export default function LoginPage() {
  // Remember a plan picked on the pricing page (?plan=starter|pro) so onboarding
  // can pre-select it after the Google round-trip. localStorage survives the
  // OAuth redirect (same origin); the query string does not.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const plan = new URLSearchParams(window.location.search).get("plan");
    if (plan === "plus" || plan === "pro") {
      try { localStorage.setItem("grindly_plan", plan); } catch {}
    }
  }, []);

  const [err] = useState(() => {
    if (typeof window === "undefined") return "";
    const e = new URLSearchParams(window.location.search).get("error");
    if (!e) return "";
    if (e === "google_denied") return "Google sign-in was cancelled.";
    if (e === "google_state") return "Sign-in session expired. Please try again.";
    if (e === "google_unverified") return "Your Google email isn't verified. Verify it with Google, then try again.";
    if (e === "rate_limited") return "Too many sign-in attempts from your network. Please wait a few minutes and try again.";
    if (e === "google_token") return "Google sign-in failed: could not retrieve your profile. Please try again.";
  if (e === "google_no_email") return "Your Google account does not have a verified email address. Please use an account with a verified email.";
  if (e === "google_not_configured") return "Google sign-in is temporarily unavailable.";
    // These two can never succeed on a retry, so "Please try again" put the user
    // in a loop with no way out and no idea why.
    if (e === "google_disabled") return "Sign-in is paused right now while we do some maintenance. Please check back a little later.";
    if (e === "domain_banned") return "We can't create an account for that email domain. If you think that's a mistake, write to mahendharsammeta21@gmail.com.";
    return "Google sign-in failed. Please try again.";
  });

  return (
    <main className="min-h-screen grid grid-cols-1 lg:grid-cols-2">
      {/* ── Left brand panel (desktop only) — proto ink aside ── */}
      <aside className="relative hidden overflow-hidden border-r border-ink bg-ink text-[var(--paper)] lg:flex lg:flex-col lg:justify-between p-[clamp(28px,4vw,52px)]">
        <div
          className="pointer-events-none absolute inset-0"
          aria-hidden
          style={{
            background:
              "radial-gradient(60% 50% at 80% 10%, rgba(227,64,42,.18) 0%, transparent 70%), radial-gradient(50% 40% at 10% 90%, rgba(227,64,42,.10) 0%, transparent 70%)",
          }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute -bottom-[14%] -right-[4%] font-display leading-none text-[rgba(242,236,225,0.045)]"
          style={{ fontSize: "clamp(16rem, 30vw, 30rem)" }}
        >
          G
        </span>

        <Link href="/" className="relative z-[2] inline-flex">
          <Logo size={34} withWordmark light />
        </Link>

        <div className="relative z-[2]">
          <h2 className="display text-[clamp(2.2rem,3.6vw,3.4rem)] leading-[1.06] text-[var(--paper)]">
            Your agent kept
            <br />
            applying while
            <br />
            <span className="accent-italic">you were away.</span>
          </h2>
          <ul className="mt-8 space-y-3.5">
            {([
              [Target, "Resume-aware matches, scored 0–100"],
              [Bolt, "Hard limits you set — the agent can't cross them"],
              [Shield, "Pay-to-apply “internships” filtered out — a real employer never charges you"],
              [Slack, "Daily progress reports, right in Slack"],
            ] as [React.ComponentType<{ size?: number }>, string][]).map(([Icon, t], i) => (
              <li key={i} className="flex items-center gap-3 text-[rgba(242,236,225,0.88)]">
                <span className="inline-flex size-9 flex-none items-center justify-center rounded-xl border border-[rgba(242,236,225,0.28)] bg-[rgba(242,236,225,0.06)]">
                  <Icon size={18} />
                </span>
                <span className="text-sm">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-[2] flex items-center gap-3 text-sm text-[rgba(242,236,225,0.7)]">
          <span className="tracking-[0.18em] text-brand">✦✦✦✦✦</span>
          Built for the intern grind across five leading job platforms
        </div>
      </aside>

      {/* ── Right sign-in panel — proto grid + panel card ── */}
      <div className="grid-bg relative flex min-w-0 items-center justify-center px-5 py-12">
        <div className="relative z-[1] w-full min-w-0 max-w-[430px]">
          <Link href="/" className="mb-7 flex justify-center lg:hidden">
            <Logo size={34} />
          </Link>

          <div className="animate-in">
            <div className="rounded-lg border border-[var(--line-2)] bg-surface p-6 shadow-[10px_10px_0_rgba(23,20,15,0.08)] sm:p-9">
              <h1 className="display text-[clamp(1.8rem,2.6vw,2.3rem)] tracking-[-0.01em]">Welcome to Grindly</h1>
              <p className="mt-1.5 text-sm text-[var(--ink-soft)]">
                Grindly is in a gated beta. Continue with Google to sign in — new
                accounts join the waitlist and get switched on once approved.
              </p>

              <a
                href="/api/auth/google"
                className="press mt-6 flex w-full items-center justify-center gap-2.5 rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-4 py-3.5 font-semibold transition hover:bg-ink hover:text-[var(--paper)] hover:border-ink"
              >
                <svg width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M47.532 24.552c0-1.636-.132-3.2-.388-4.704H24.48v8.896h12.956c-.568 2.952-2.22 5.456-4.692 7.132v5.912h7.572c4.432-4.072 6.988-10.072 6.988-17.236z" fill="#4285F4"/>
                  <path d="M24.48 48c6.48 0 11.916-2.148 15.888-5.812l-7.572-5.912c-2.148 1.44-4.896 2.288-8.316 2.288-6.396 0-11.82-4.32-13.748-10.128H2.9v6.1C6.856 42.86 15.088 48 24.48 48z" fill="#34A853"/>
                  <path d="M10.732 28.436A14.4 14.4 0 0 1 9.9 24c0-1.54.264-3.036.732-4.436v-6.1H2.9A23.952 23.952 0 0 0 .48 24c0 3.864.924 7.524 2.42 10.536l8.332-6.1z" fill="#FBBC05"/>
                  <path d="M24.48 9.552c3.604 0 6.836 1.24 9.38 3.672l6.972-6.972C36.388 2.352 30.96 0 24.48 0 15.088 0 6.856 5.14 2.9 13.464l7.832 6.1C12.66 13.872 18.084 9.552 24.48 9.552z" fill="#EA4335"/>
                </svg>
                Continue with Google
              </a>

              {err && <p className="mt-4 text-sm text-danger">{err}</p>}

              <p className="mt-6 text-xs text-muted">
                By continuing you agree to let Grindly prepare supported job applications within the limits you set and submit only after your approval.
                This sign-in only verifies your identity (name and email). Connecting Gmail for
                application tracking is a separate, optional step with its own permission request later on.
                See our{" "}
                <Link href="/privacy" className="underline hover:text-ink">Privacy Policy</Link>{" "}
                and{" "}
                <Link href="/terms" className="underline hover:text-ink">Terms of Service</Link>{" "}
                for details.
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
