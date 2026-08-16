"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ message: string; devLink?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work.");
        setBusy(false);
        return;
      }
      setSent({ message: data.message, devLink: data.devLink });
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-6 py-16">
      <Link href="/" className="mb-10 inline-flex">
        <Logo />
      </Link>
      <h1 className="font-display text-3xl font-bold">Reset your password</h1>

      {sent ? (
        <>
          <p className="mt-3 leading-relaxed">{sent.message}</p>
          {sent.devLink && (
            <div className="bg-surface-2 border-border mt-4 rounded-lg border p-3">
              <p className="text-muted text-xs">
                This server has no mail transport configured, so the link is here
                instead of in an inbox.
              </p>
              <a href={sent.devLink} className="text-brand mt-2 block break-all text-sm underline">
                {sent.devLink}
              </a>
            </div>
          )}
          <Link href="/login" className="text-muted hover:text-ink mt-8 text-sm">
            ← Back to sign in
          </Link>
        </>
      ) : (
        <>
          <p className="text-muted mt-2 text-sm leading-relaxed">
            Enter the address you signed up with and we will send you a link. It
            works once and expires in 45 minutes.
          </p>
          <form onSubmit={submit} className="mt-8" noValidate>
            <label className="block">
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
            {error && (
              <p role="alert" className="mt-4 text-sm" style={{ color: "#a3271b" }}>
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="btn btn-primary mt-6 w-full justify-center"
            >
              {busy ? "Sending…" : "Send me a link"}
            </button>
          </form>
          <Link href="/login" className="text-muted hover:text-ink mt-8 text-sm">
            ← Back to sign in
          </Link>
        </>
      )}
    </main>
  );
}
