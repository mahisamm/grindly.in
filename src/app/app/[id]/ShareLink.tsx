"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * A link to the readiness report, for someone without an account.
 *
 * The thing being shared is the MEASUREMENT — score, bands, findings — and not
 * the resume, the PDFs, the contact details, or even the filename, which is
 * usually the owner's own name. That is what makes an unguessable URL an
 * acceptable access control here: what is behind it identifies nobody.
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

  const url = token && typeof window !== "undefined" ? `${window.location.origin}/r/${token}` : null;

  async function create() {
    setBusy(true);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/share`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) setToken(data.token);
      router.refresh();
    } catch {
      /* the button stays where it was; pressing it again is the retry */
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await fetch(`/api/resumes/${resumeId}/share`, { method: "DELETE" });
      setToken(null);
      router.refresh();
    } catch {
      /* as above */
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
        A link anyone can open — showing the score, the bands and the findings, and
        nothing else. Not your resume, not the rebuilt PDFs, not your contact details,
        not even the file name. Useful for the senior who offered to look over your CV.
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
    </div>
  );
}
