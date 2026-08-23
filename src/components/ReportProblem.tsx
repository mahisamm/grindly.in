"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Feedback, in two shapes built on one form.
 *
 *   <FeedbackDialog open onClose />  — the form as a centred modal. Opened
 *     from the Account menu ("Send feedback") inside the signed-in app, where
 *     it used to be a floating corner button that competed with the phone nav
 *     and read as "report a complaint" rather than "tell us anything".
 *   <ReportProblem />                — the old floating trigger + the same
 *     form, still mounted on the pages with no account menu (/contact, the
 *     approval-pending page).
 *
 * Both post to /api/problems with the page path and, when the URL carries one,
 * the resume id — so the person never has to describe where they were.
 */

function useResumeIdFromPath(pathname: string | null): string {
  const m = pathname?.match(/^\/app\/([^/]+)/);
  const candidate = m?.[1];
  if (!candidate || candidate === "settings" || candidate === "resumes" || candidate === "support") return "";
  return candidate;
}

function FeedbackForm({ onDone, autoFocus }: { onDone: () => void; autoFocus: boolean }) {
  const pathname = usePathname();
  const resumeId = useResumeIdFromPath(pathname);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) boxRef.current?.focus();
  }, [autoFocus]);

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

  if (sent) {
    return (
      <>
        <p className="text-sm leading-relaxed">{sent}</p>
        <button onClick={onDone} className="btn mt-4 w-full justify-center text-sm">
          Close
        </button>
      </>
    );
  }

  return (
    <form onSubmit={submit}>
      <p className="text-sm font-medium">Tell us anything</p>
      <p className="text-muted mt-1 text-xs leading-relaxed">
        Something that looked wrong, something confusing, something you liked, something
        you wish it did. We record the page you are on, so you do not have to describe it.
        Need an answer back? Raise a ticket instead — that one is a conversation.
      </p>
      <label htmlFor="feedback-message" className="sr-only">
        Your feedback
      </label>
      <textarea
        id="feedback-message"
        ref={boxRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        rows={5}
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
          {busy ? "Sending…" : "Send feedback"}
        </button>
        <button type="button" onClick={onDone} className="btn text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The feedback form as a modal. Escape and the backdrop close it. */
export function FeedbackDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[90] flex items-end justify-center p-4 sm:items-center"
      style={{ background: "rgba(31, 26, 20, 0.45)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Send feedback"
        className="bg-surface border-border w-full max-w-md rounded-2xl border p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <FeedbackForm onDone={onClose} autoFocus />
      </div>
    </div>
  );
}

/** The floating corner trigger, for pages without an account menu. */
export function ReportProblem() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="report-problem">
      {open && (
        <div
          role="dialog"
          aria-label="Send feedback"
          className="bg-surface border-border mb-2 w-[min(22rem,calc(100vw-2rem))] rounded-xl border p-4 shadow-lg"
        >
          <FeedbackForm onDone={() => setOpen(false)} autoFocus />
        </div>
      )}
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="report-problem__trigger">
        {open ? "Close" : "Send feedback"}
      </button>
    </div>
  );
}
