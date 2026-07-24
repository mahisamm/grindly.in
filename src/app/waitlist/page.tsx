"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Logo } from "@/components/Brand";

type State = "loading" | "pending" | "requested" | "denied" | "signedout";

export default function WaitlistPage() {
  const [state, setState] = useState<State>("loading");
  const [email, setEmail] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => {
        if (!alive) return;
        setEmail(d.user?.email ?? "");
        const status = d.user?.accessStatus as string | undefined;
        const allowed = d.user?.hasAccess ?? (d.user?.role === "admin" || status === "approved");
        if (allowed) {
          // Already in — resume onboarding if it isn't finished, else the dashboard.
          window.location.href = d.user?.status === "onboarding" ? "/onboarding" : "/dashboard";
          return;
        }
        if (status === "denied") setState("denied");
        else if (d.user?.accessRequestedAt) setState("requested");
        else setState("pending");
      })
      .catch(() => alive && setState("signedout"));
    return () => {
      alive = false;
    };
  }, []);

  async function requestAccess() {
    setSubmitting(true);
    setErr("");
    try {
      const r = await fetch("/api/access/request", { method: "POST" });
      if (r.ok) {
        setState("requested");
        return;
      }
      // A non-ok used to fall straight through the `finally` and just re-enable
      // the button, which is indistinguishable from a dead button — on the only
      // action this page has.
      const d = await r.json().catch(() => ({}));
      setErr(
        r.status === 401
          ? "Your session expired. Sign in with Google again, then request access."
          : (d as { error?: string }).error ||
            "Could not send your request. Please try again in a moment.",
      );
    } catch {
      setErr("Network error — check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function signOut() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      window.location.href = "/";
    }
  }

  return (
    <main className="grid-bg relative flex min-h-screen items-center justify-center px-5 py-12">
      <div className="relative z-[1] w-full max-w-[460px]">
        <Link href="/" className="mb-7 flex justify-center">
          <Logo size={34} withWordmark />
        </Link>

        <div className="animate-in rounded-lg border border-[var(--line-2)] bg-surface p-6 shadow-[10px_10px_0_rgba(23,20,15,0.08)] sm:p-9">
          {state === "loading" && (
            <p className="text-sm text-muted">Loading…</p>
          )}

          {state === "signedout" && (
            <>
              <h1 className="display text-[clamp(1.7rem,2.6vw,2.2rem)] tracking-[-0.01em]">
                Request beta access
              </h1>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">
                Grindly is in a gated beta. Sign in with Google and we&apos;ll add
                you to the waitlist — you&apos;ll get in as soon as we approve your
                email.
              </p>
              <a
                href="/api/auth/google"
                className="press mt-6 flex w-full items-center justify-center gap-2.5 rounded-full border border-[var(--line-2)] bg-[var(--paper)] px-4 py-3.5 font-semibold transition hover:bg-ink hover:text-[var(--paper)] hover:border-ink"
              >
                Continue with Google
              </a>
            </>
          )}

          {state === "pending" && (
            <>
              <span className="inline-flex items-center gap-2 rounded-full border border-brand/40 bg-brand/10 px-3 py-1 text-xs font-medium text-brand">
                <span className="size-1.5 rounded-full bg-brand" /> Gated beta
              </span>
              <h1 className="display mt-4 text-[clamp(1.7rem,2.6vw,2.2rem)] tracking-[-0.01em]">
                You&apos;re on the list
              </h1>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">
                Grindly&apos;s free beta is invite-only while we finish building it, so
                access for <span className="font-medium text-ink">{email}</span> is
                paused for now. Request a spot below and we&apos;ll reach out if one
                opens — and paid plans are coming soon, so you&apos;ll have a way in
                either way.
              </p>
              <button
                onClick={requestAccess}
                disabled={submitting}
                className="press mt-6 w-full rounded-full bg-ink px-4 py-3.5 font-semibold text-[var(--paper)] transition hover:opacity-90 disabled:opacity-50"
              >
                {submitting ? "Requesting…" : "Request access"}
              </button>
              {err && <p className="mt-3 text-sm text-danger">{err}</p>}
            </>
          )}

          {state === "requested" && (
            <>
              <span className="inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs font-medium text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> On the waitlist
              </span>
              <h1 className="display mt-4 text-[clamp(1.7rem,2.6vw,2.2rem)] tracking-[-0.01em]">
                Request received
              </h1>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">
                You&apos;re on the list for{" "}
                <span className="font-medium text-ink">{email}</span>. We review
                requests daily.{" "}
                <span className="font-medium text-ink">
                  Sign in again in a day or two to check
                </span>{" "}
                — the moment you&apos;re approved this page takes you straight to
                setup.
              </p>
            </>
          )}

          {state === "denied" && (
            <>
              <h1 className="display text-[clamp(1.7rem,2.6vw,2.2rem)] tracking-[-0.01em]">
                Access unavailable
              </h1>
              <p className="mt-2 text-sm text-[var(--ink-soft)]">
                We aren&apos;t able to grant access to{" "}
                <span className="font-medium text-ink">{email}</span> right now. If
                you think this is a mistake, write to{" "}
                <a href="mailto:mahendharsammeta21@gmail.com" className="underline hover:text-ink">
                  mahendharsammeta21@gmail.com
                </a>{" "}
                and we&apos;ll take another look.
              </p>
            </>
          )}

          <div className="mt-7 border-t border-[var(--line-2)] pt-5 text-xs text-muted">
            {state !== "signedout" && (
              <>
                <button onClick={signOut} className="underline hover:text-ink">
                  Sign out
                </button>
                <span className="mx-2">·</span>
              </>
            )}
            <Link href="/" className="underline hover:text-ink">
              Back to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
