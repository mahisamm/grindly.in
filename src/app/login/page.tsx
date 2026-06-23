"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";
import { PaperPlane, Target, Bolt, Slack, Star } from "@/components/Doodles";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"form" | "otp">("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(() => {
    if (typeof window === "undefined") return "";
    const e = new URLSearchParams(window.location.search).get("error");
    if (e === "google_denied") return "Google sign-in was cancelled.";
    if (e) return "Google sign-in failed. Please try again.";
    return "";
  });

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Login failed");
      return;
    }
    if (j.step === "otp") {
      setMaskedPhone(j.maskedPhone || "your number");
      setStep("otp");
      return;
    }
    router.push(j.status === "onboarding" ? "/onboarding" : "/dashboard");
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    // login OTP verify: server resolves phone from pending session by email
    const res = await fetch("/api/auth/verify-login-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, code: otp }),
    });
    setLoading(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Invalid OTP");
      return;
    }
    router.push(j.status === "onboarding" ? "/onboarding" : "/dashboard");
  }

  async function resendOtp() {
    setErr("");
    await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setErr("OTP resent.");
  }

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
          Built for the intern grind across 5 platforms
        </div>
      </aside>

      {/* ── Right form panel ── */}
      <div className="grid-bg grain relative flex items-center justify-center px-5 py-12">
        <div className="relative z-[1] w-full max-w-md">
          <Link href="/" className="mb-8 flex justify-center lg:hidden">
            <Logo size={34} />
          </Link>

          <div className="animate-in">
        {step === "form" ? (
          <div className="sticker rounded-3xl bg-surface p-8">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-1 text-sm text-muted">Log in to your NexPath dashboard.</p>

            <a
              href="/api/auth/google"
              className="press mt-6 flex items-center justify-center gap-2.5 w-full rounded-xl border-2 border-ink bg-surface sticker-sm px-4 py-2.5 font-medium hover:bg-surface-2 transition"
            >
              <svg width="18" height="18" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M47.532 24.552c0-1.636-.132-3.2-.388-4.704H24.48v8.896h12.956c-.568 2.952-2.22 5.456-4.692 7.132v5.912h7.572c4.432-4.072 6.988-10.072 6.988-17.236z" fill="#4285F4"/>
                <path d="M24.48 48c6.48 0 11.916-2.148 15.888-5.812l-7.572-5.912c-2.148 1.44-4.896 2.288-8.316 2.288-6.396 0-11.82-4.32-13.748-10.128H2.9v6.1C6.856 42.86 15.088 48 24.48 48z" fill="#34A853"/>
                <path d="M10.732 28.436A14.4 14.4 0 0 1 9.9 24c0-1.54.264-3.036.732-4.436v-6.1H2.9A23.952 23.952 0 0 0 .48 24c0 3.864.924 7.524 2.42 10.536l8.332-6.1z" fill="#FBBC05"/>
                <path d="M24.48 9.552c3.604 0 6.836 1.24 9.38 3.672l6.972-6.972C36.388 2.352 30.96 0 24.48 0 15.088 0 6.856 5.14 2.9 13.464l7.832 6.1C12.66 13.872 18.084 9.552 24.48 9.552z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </a>

            <div className="my-5 flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={submitForm} className="space-y-4">
              <div>
                <label className="text-sm text-muted">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@email.com"
                  className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                />
              </div>
              <div>
                <label className="text-sm text-muted">Password</label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                />
              </div>
              {err && <p className="text-sm text-danger">{err}</p>}
              <button
                disabled={loading}
                className="press w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition disabled:opacity-60"
              >
                {loading ? "Sending OTP…" : "Log in"}
              </button>
            </form>
          </div>
        ) : (
          <div className="sticker rounded-3xl bg-surface p-8">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Verify your identity</h1>
            <p className="mt-1 text-sm text-muted">
              OTP sent to <span className="text-foreground font-medium">{maskedPhone}</span>. Valid for 10 minutes.
            </p>
            <form onSubmit={submitOtp} className="mt-6 space-y-4">
              <div>
                <label className="text-sm text-muted">6-digit OTP</label>
                <input
                  type="text"
                  required
                  maxLength={6}
                  pattern="\d{6}"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  placeholder="123456"
                  className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition tracking-widest text-center text-xl"
                />
              </div>
              {err && <p className="text-sm text-danger">{err}</p>}
              <button
                disabled={loading}
                className="press w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition disabled:opacity-60"
              >
                {loading ? "Verifying…" : "Verify & Log in"}
              </button>
              <button
                type="button"
                onClick={resendOtp}
                className="w-full text-sm text-muted hover:text-foreground transition"
              >
                Resend OTP
              </button>
            </form>
          </div>
        )}

            <p className="mt-6 text-center text-sm text-muted">
              New here?{" "}
              <Link href="/signup" className="brand-text font-medium">
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
