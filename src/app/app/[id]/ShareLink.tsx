"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * A link to the readiness report, for someone without an account.
 *
 * The thing being shared is the MEASUREMENT — score, bands, findings — plus
 * the candidate's name off the resume header, because owners send these links
 * saying "look at my report" and a page that refused to say whose it was made
 * every recipient ask. The line is drawn there: no email, no phone, no resume
 * text, no PDFs, no file label. See r/[token]/page.tsx.
 *
 * Said out loud in the interface rather than only in a comment, because someone
 * about to send a link to a stranger deserves to know what is in it.
 */
export function ShareLink({
  resumeId,
  initialToken,
}: {
  resumeId: string;
  initialToken: string | null;
}) {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const url = token && typeof window !== "undefined" ? `${window.location.origin}/r/${token}` : null;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/share`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not create a link.");
        return;
      }
      setToken(data.token);
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/share`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The link is still live if this failed — saying so matters more here
        // than anywhere else on the page, because revoking is the safety step.
        setError(data?.error ?? "Could not revoke the link. It is still live.");
        return;
      }
      setToken(null);
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      /* the URL is on screen and selectable */
    }
  }

  return (
    <div className="bg-surface border-border mt-4 rounded-xl border p-5">
      <h3 className="font-display text-lg font-semibold">Share this report</h3>
      <p className="text-muted mt-1.5 text-sm leading-relaxed">
        A link anyone can open — showing your name as it appears on the resume, the
        score, the bands and the findings, and nothing else. Not the resume itself,
        not the rebuilt PDFs, not your email or phone, not the file name. Useful for
        the senior who offered to look over your CV.
      </p>

      {token && url ? (
        <>
          <div className="bg-surface-2 border-border mt-4 rounded-lg border p-3">
            <code className="text-xs break-all">{url}</code>
          </div>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <button onClick={copy} className="text-brand cursor-pointer underline">
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              onClick={revoke}
              disabled={busy}
              className="text-muted hover:text-ink cursor-pointer underline"
            >
              {busy ? "Revoking…" : "Revoke it"}
            </button>
          </div>
          <p className="text-muted mt-3 text-xs leading-relaxed">
            Revoking kills this address for good rather than replacing it — which is the
            point of revoking. Search engines are asked not to index it.
          </p>
        </>
      ) : (
        <button onClick={create} disabled={busy} className="btn mt-4 w-full justify-center sm:w-auto">
          {busy ? "Creating…" : "Create a link"}
        </button>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
    </div>
  );
}
