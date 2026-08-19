"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Logo } from "@/components/Brand";

/**
 * Confirm an email address.
 *
 * A button, not an automatic POST on mount. Mail providers and corporate
 * security appliances fetch every link in a message before a human sees it, and
 * anything that spends the token on page load spends it for them — the user
 * then clicks and is told the link has already been used. One deliberate press
 * is the whole defence, and it costs a click on a page people reach once.
 */
export function VerifyForm() {
  const token = useSearchParams().get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; changed: boolean } | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work.");
        setBusy(false);
        return;
      }
      setDone({ email: data.email, changed: Boolean(data.changed) });
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
            It is missing its token. Open the link from the email again, or ask for a
            fresh one from your account page.
          </p>
          <Link href="/app/settings" className="btn btn-primary mt-8 justify-center">
            Go to my account
          </Link>
        </>
      ) : done ? (
        <>
          <h1 className="font-display text-3xl font-bold">
            {done.changed ? "Address changed" : "Address confirmed"}
          </h1>
          <p className="text-muted mt-3 leading-relaxed">
            {done.changed ? (
              <>
                Your account now signs in with <b>{done.email}</b>. Your password has
                not changed.
              </>
            ) : (
              <>
                <b>{done.email}</b> is confirmed. If you ever need to reset your
                password, we can now actually reach you.
              </>
            )}
          </p>
          <Link href="/app" className="btn btn-primary mt-8 justify-center">
            Back to my resumes
          </Link>
        </>
      ) : (
        <>
          <h1 className="font-display text-3xl font-bold">Confirm this address</h1>
          <p className="text-muted mt-3 leading-relaxed">
            One press and we know this mailbox reaches you. Nothing else changes, and
            you can keep using Grindly either way.
          </p>
          {error && (
            <p role="alert" className="mt-5 text-sm" style={{ color: "#a3271b" }}>
              {error}
            </p>
          )}
          <button
            onClick={confirm}
            disabled={busy}
            className="btn btn-primary mt-8 justify-center"
          >
            {busy ? "Confirming…" : "Confirm my address"}
          </button>
        </>
      )}
    </main>
  );
}
