"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function SignupPage() {
  const router = useRouter();
  const [step, setStep] = useState<"form" | "otp">("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [maskedPhone, setMaskedPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function submitForm(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    const res = await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, phone, password }),
    });
    setLoading(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Something went wrong");
      return;
    }
    setMaskedPhone(j.maskedPhone || phone);
    setStep("otp");
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    const res = await fetch("/api/auth/verify-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone, code: otp }),
    });
    setLoading(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Invalid OTP");
      return;
    }
    router.push("/onboarding");
  }

  async function resendOtp() {
    setErr("");
    await fetch("/api/auth/send-otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
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
            <h1 className="font-display text-3xl font-semibold tracking-tight">Create your account</h1>
            <p className="mt-1 text-sm text-muted">
              Upload your resume and the agent takes it from there.
            </p>
            <form onSubmit={submitForm} className="mt-6 space-y-4">
              <div>
                <label className="text-sm text-muted">Name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                />
              </div>
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
                <label className="text-sm text-muted">Mobile Number</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="9876543210"
                  className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                />
                <p className="mt-1 text-xs text-muted">Indian number: 10 digits. OTP will be sent for verification.</p>
              </div>
              <div>
                <label className="text-sm text-muted">Password</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                />
              </div>
              {err && <p className="text-sm text-danger">{err}</p>}
              <button
                disabled={loading}
                className="w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition disabled:opacity-60"
              >
                {loading ? "Sending OTP…" : "Continue"}
              </button>
            </form>
          </div>
        ) : (
          <div className="sticker rounded-3xl bg-surface p-8">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Verify your number</h1>
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
                {loading ? "Verifying…" : "Verify & Continue"}
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
          Already have an account?{" "}
          <Link href="/login" className="brand-text font-medium">
            Log in
          </Link>
        </p>
      </div>
    </main>
  );
}
