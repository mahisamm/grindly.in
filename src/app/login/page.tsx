"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { PaperPlane, Target, Bolt, Slack, Star } from "@/components/Doodles";

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
    if (plan === "starter" || plan === "pro") {
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
    if (e === "google_token") return "Google sign-in failed: could not retrieve your profile. Please try again.";
  if (e === "google_no_email") return "Your Google account does not have a verified email address. Please use an account with a verified email.";
  if (e === "google_not_configured") return "Google sign-in is temporarily unavailable.";
    return "Google sign-in failed. Please try again.";
  });

  return (
    <main className="min-h-screen grid lg:grid-cols-2">
      {/* ── Left brand panel (desktop only) ── */}
      <aside className="relative hidden overflow-hidden border-r-2 border-ink bg-brand text-white lg:flex lg:flex-col lg:justify-between p-12">
        <div className="mesh opacity-70" aria-hidden />
        <PaperPlane className="absolute right-10 top-24 z-[1] text-white/30 wobble" size={64} />
        <Star className="absolute left-10 bottom-40 z-[1] text-white/25" size={40} />

        <Link href="/" className="relative z-[2] inline-flex">
          <Logo size={34} withWordmark light />
        </Link>

        <div className="relative z-[2]">
          <h2 className="display text-4xl xl:text-5xl leading-[0.95]">
            Your agent kept
            <br />
            applying while
            <br />
            you were away.
          </h2>
          <ul className="mt-8 space-y-3.5 text-white/90">
            {([
              [Target, "Resume-aware matches, scored 0–100"],
              [Bolt, "Hard limits you set — the agent can't cross them"],
              [Slack, "Daily progress reports, right in Slack"],
            ] as [React.ComponentType<{ size?: number }>, string][]).map(([Icon, t], i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="inline-flex size-9 items-center justify-center rounded-xl border-2 border-white/30 bg-white/10">
                  <Icon size={20} />
                </span>
                <span className="text-sm">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-[2] flex items-center gap-3 text-sm text-white/75">
          <span className="flex text-[#ffd9b8]">
            {[0, 1, 2, 3, 4].map((i) => <Star key={i} size={15} />)}
          </span>
          Built for the intern grind on Internshala
        </div>
      </aside>

      {/* ── Right sign-in panel ── */}
      <div className="grid-bg grain relative flex items-center justify-center px-5 py-12">
        <div className="relative z-[1] w-full max-w-md">
          <Link href="/" className="mb-8 flex justify-center lg:hidden">
            <Logo size={34} />
          </Link>

          <div className="animate-in">
            <div className="sticker rounded-3xl bg-surface p-6 sm:p-8">
              <h1 className="font-display text-3xl font-semibold tracking-tight">Welcome to Grindly</h1>
              <p className="mt-1 text-sm text-muted">Continue with Google to start your agent.</p>

              <a
                href="/api/auth/google"
                className="press mt-6 flex items-center justify-center gap-2.5 w-full rounded-xl border-2 border-ink bg-surface sticker-sm px-4 py-3 font-medium hover:bg-surface-2 transition"
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
                By continuing you agree to let Grindly apply to jobs on your behalf within the limits you set.
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
