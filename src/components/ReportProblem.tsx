"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * "Something is wrong" — one button, always in reach.
 *
 * This exists because of what the error table CANNOT see. `ErrorEvent` records
 * faults the software noticed: an exception, a timeout, a provider refusing.
 * The failures that matter most in a product built on measurement are the ones
 * where nothing threw and the answer was simply wrong — a rewrite that dropped a
 * job, a score that does not match the document. Those reach us only if a person
 * types them.
 *
 * Three deliberate choices:
 *
 *   It captures the page and the resume in view rather than asking. "Which page
 *   were you on?" is a question people answer wrongly and resent being asked,
 *   and the answer is the difference between a report someone can open and one
 *   they can only sympathise with.
 *
 *   It is available to accounts waiting on the beta queue. The person locked out
 *   by a gate that misfired is exactly who needs to reach the operator.
 *
 *   It never blocks the page. Bottom-right, above the mobile nav, and it moves
 *   out of the way of the thumb bar rather than sitting on top of it.
 */
export function ReportProblem() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Focus the box when the panel opens, and close on Escape. A floating panel
  // that traps neither focus nor Escape is a panel keyboard users cannot leave.
  useEffect(() => {
    if (!open) return;
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  /**
   * The resume being looked at, read from the URL.
   *
   * /app/<id> and /app/<id>/edit both carry it. Taken from the path rather than
   * threaded down through props, so this component can sit in the layout and
   * work on every page without each one having to hand it something.
   */
  const resumeId = (() => {
    const m = pathname?.match(/^\/app\/([^/]+)/);
    const candidate = m?.[1];
    if (!candidate || candidate === "settings") return "";
    return candidate;
  })();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/problems", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, path: pathname, resumeId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not send.");
        return;
      }
      setSent(data.message ?? "Thank you.");
      setMessage("");
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="report-problem">
      {open && (
        <div
          role="dialog"
          aria-label="Report a problem"
          className="bg-surface border-border mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border p-4 shadow-lg"
        >
          {sent ? (
            <>
              <p className="text-sm leading-relaxed">{sent}</p>
              <button
                onClick={() => {
                  setSent(null);
                  setOpen(false);
                }}
                className="btn mt-4 w-full justify-center text-sm"
              >
                Close
              </button>
            </>
          ) : (
            <form onSubmit={submit}>
              <p className="text-sm font-medium">What went wrong?</p>
              <p className="text-muted mt-1 text-xs leading-relaxed">
                Anything that looked wrong, confusing, or simply did not work. We record
                the page you are on, so you do not have to describe it.
              </p>
              <label htmlFor="problem-message" className="sr-only">
                What went wrong
              </label>
              <textarea
                id="problem-message"
                ref={boxRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={4}
                maxLength={4000}
                className="field mt-3 w-full text-sm"
                placeholder="The rewrite dropped my second job entirely…"
              />
              {error && (
                <p role="alert" className="mt-2 text-xs" style={{ color: "#a3271b" }}>
                  {error}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  disabled={busy || message.trim().length < 10}
                  className="btn btn-primary flex-1 justify-center text-sm"
                >
                  {busy ? "Sending…" : "Send"}
                </button>
                <button type="button" onClick={() => setOpen(false)} className="btn text-sm">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="report-problem__trigger"
      >
        {open ? "Close" : "Report a problem"}
      </button>
    </div>
  );
}
