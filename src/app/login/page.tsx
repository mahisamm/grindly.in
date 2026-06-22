"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"form" | "otp">("form");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

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
      // store phone hint for verify call — we don't have the plain phone here,
      // so we pass the masked value and let the server look up by session token
      setPhone(j.maskedPhone || "");
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
    <main className="grid-bg min-h-screen flex items-center justify-center px-5">
      <div className="w-full max-w-md">
        <Link href="/" className="flex justify-center mb-8">
          <Logo size={34} />
        </Link>

        {step === "form" ? (
          <div className="sticker rounded-3xl bg-surface p-8">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-1 text-sm text-muted">Log in to your NexPath dashboard.</p>
            <form onSubmit={submitForm} className="mt-6 space-y-4">
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
                className="w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition disabled:opacity-60"
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
                className="w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition disabled:opacity-60"
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
    </main>
  );
}
