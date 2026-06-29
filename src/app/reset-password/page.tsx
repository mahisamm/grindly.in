"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [token, setToken] = useState("");

  const [step, setStep] = useState<"form" | "done">("form");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("token") ?? "";
    /* eslint-disable react-hooks/set-state-in-effect -- one-time read of ?token= from the reset link */
    setToken(t);
    if (!t) setErr("Missing or invalid reset link. Please request a new one.");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (password !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setLoading(false);
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      setErr(j.error || "Something went wrong. Please try again.");
      return;
    }
    setStep("done");
  }

  return (
    <main className="min-h-screen grid-bg grain flex items-center justify-center px-5 py-12">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 flex justify-center">
          <Logo size={34} />
        </Link>

        <div className="sticker rounded-3xl bg-surface p-6 sm:p-8 animate-in">
          {step === "done" ? (
            <>
              <h1 className="font-display text-3xl font-semibold tracking-tight">Password updated</h1>
              <p className="mt-2 text-sm text-muted">Your password has been changed successfully.</p>
              <button
                onClick={() => router.push("/login")}
                className="press mt-6 w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition"
              >
                Log in
              </button>
            </>
          ) : (
            <>
              <h1 className="font-display text-3xl font-semibold tracking-tight">Set new password</h1>
              <p className="mt-1 text-sm text-muted">Choose a password at least 6 characters long.</p>

              <form onSubmit={handleSubmit} className="mt-6 space-y-4">
                <div>
                  <label className="text-sm text-muted">New password</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                  />
                </div>
                <div>
                  <label className="text-sm text-muted">Confirm password</label>
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="••••••••"
                    className="mt-1 w-full rounded-xl border-2 border-border bg-surface-2 px-3 py-2.5 outline-none focus:border-brand transition"
                  />
                </div>
                {err && <p className="text-sm text-danger">{err}</p>}
                <button
                  disabled={loading || !token}
                  className="press w-full rounded-xl brand-gradient sticker-sm px-4 py-2.5 font-semibold hover:opacity-90 transition disabled:opacity-60"
                >
                  {loading ? "Updating…" : "Update password"}
                </button>
              </form>

              <p className="mt-4 text-center text-sm text-muted">
                <Link href="/login" className="brand-text font-medium">Back to log in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
