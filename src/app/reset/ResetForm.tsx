"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Logo } from "@/components/Brand";

export function ResetForm() {
  const token = useSearchParams().get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work.");
        setBusy(false);
        return;
      }
      setDone(true);
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

      {!token ? (
        <>
          <h1 className="font-display text-3xl font-bold">That link is incomplete</h1>
          <p className="text-muted mt-3 leading-relaxed">
            It is missing its token. Ask for a fresh one — links expire after 45
            minutes and work only once.
          </p>
          <Link href="/forgot" className="btn btn-primary mt-8 justify-center">
            Send me a new link
          </Link>
        </>
      ) : done ? (
        <>
          <h1 className="font-display text-3xl font-bold">Password changed</h1>
          <p className="text-muted mt-3 leading-relaxed">
            Every device that was signed in has been signed out, including this
            one. Sign in with your new password.
          </p>
          <Link href="/login" className="btn btn-primary mt-8 justify-center">
            Sign in
          </Link>
        </>
      ) : (
        <>
          <h1 className="font-display text-3xl font-bold">Choose a new password</h1>
          <form onSubmit={submit} className="mt-8" noValidate>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">New password</span>
              <input
                type="password"
                required
                value={password}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
                className="field w-full"
                placeholder="At least 10 characters"
              />
              <span className="text-muted mt-1.5 block text-xs">
                Ten characters or more. Length beats symbols.
              </span>
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
              {busy ? "Saving…" : "Set new password"}
            </button>
          </form>
        </>
      )}
    </main>
  );
}
