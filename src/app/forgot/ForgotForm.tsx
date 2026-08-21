"use client";

import { useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";

export function ForgotForm({ mailAvailable = true }: { mailAvailable?: boolean }) {
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
      ) : !mailAvailable ? (
        /* Said before they type anything.
           Without SMTP the reset link is written to a file on the server, and
           the old copy here promised mail that was never going to arrive — in
           the one place a user cannot check for themselves. */
        <>
          <div
            role="status"
            className="mt-4 rounded-lg border p-4 text-sm leading-relaxed"
            style={{ borderColor: "var(--warn)", background: "var(--surface-2)" }}
          >
            <p className="font-medium">We cannot email you yet.</p>
            <p className="text-muted mt-1">
              This server has no mail set up, so a reset link cannot reach you — and
              saying one was on its way would not be true.
            </p>
          </div>
          <p className="text-muted mt-4 text-sm leading-relaxed">
            If you signed up with Google, nothing is lost: use the Google button on the
            sign-in page. Otherwise ask whoever runs this site to reset it for you.
          </p>
          <Link href="/login" className="btn btn-primary mt-8 justify-center">
            Back to sign in
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
                placeholder="you@example.com"
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
