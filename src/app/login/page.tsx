"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setLoading(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErr(j.error || "Login failed");
      return;
    }
    const j = await res.json();
    router.push(j.status === "onboarding" ? "/onboarding" : "/dashboard");
  }

  return (
    <main className="grid-bg min-h-screen flex items-center justify-center px-5">
      <div className="w-full max-w-md">
        <Link href="/" className="flex justify-center mb-8">
          <Logo size={34} />
        </Link>
        <div className="glass rounded-2xl p-8 glow">
          <h1 className="text-2xl font-semibold tracking-tight">Welcome back</h1>
          <p className="mt-1 text-sm text-muted">Log in to your InternPilot dashboard.</p>
          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <label className="text-sm text-muted">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@email.com"
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2.5 outline-none focus:border-brand transition"
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
                className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2.5 outline-none focus:border-brand transition"
              />
            </div>
            {err && <p className="text-sm text-danger">{err}</p>}
            <button
              disabled={loading}
              className="w-full rounded-lg brand-gradient px-4 py-2.5 font-medium text-white hover:opacity-90 transition disabled:opacity-60"
            >
              {loading ? "Logging in…" : "Log in"}
            </button>
          </form>
        </div>
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
