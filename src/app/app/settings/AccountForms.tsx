"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The three things you could not do to your own account.
 *
 * Changing a password meant signing out and using the forgot-password flow —
 * the recovery path for someone who has LOST their password, used as the
 * routine path for someone who simply wants to rotate it. Changing an email
 * address was not possible at all. Getting your data out meant opening every
 * resume and downloading each PDF by hand, and the scores could not be got out
 * at all.
 *
 * One client component rather than three, because they share a form idiom and
 * splitting them would triple the boilerplate for no reader's benefit.
 */

type Feedback = { kind: "ok" | "error"; text: string } | null;

function Notice({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return (
    <p
      role={feedback.kind === "error" ? "alert" : "status"}
      className="mt-3 rounded-lg border p-3 text-sm leading-snug"
      style={{
        borderColor: feedback.kind === "error" ? "#a3271b" : "var(--border)",
        color: feedback.kind === "error" ? "#a3271b" : "var(--ink-color)",
        background: feedback.kind === "error" ? "transparent" : "var(--surface-2)",
      }}
    >
      {feedback.text}
    </p>
  );
}

// ---------------------------------------------------------------------------

export function ChangePassword({ googleOnly }: { googleOnly: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  if (googleOnly) {
    return (
      <p className="text-muted mt-2 text-sm leading-relaxed">
        This account signs in with Google, so there is no password here to change.
        Manage it in your Google account.
      </p>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ kind: "error", text: data?.error ?? "That did not work." });
        return;
      }
      setFeedback({ kind: "ok", text: data.message ?? "Password changed." });
      setCurrent("");
      setNext("");
    } catch {
      setFeedback({ kind: "error", text: "We could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-4">
      <p className="text-muted text-sm leading-relaxed">
        Changing it signs out every other device. This one stays signed in.
      </p>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-sm font-medium">Current password</span>
        <input
          type="password"
          required
          value={current}
          autoComplete="current-password"
          onChange={(e) => setCurrent(e.target.value)}
          className="field w-full"
        />
      </label>
      <label className="mt-3 block">
        <span className="mb-1.5 block text-sm font-medium">New password</span>
        <input
          type="password"
          required
          value={next}
          autoComplete="new-password"
          onChange={(e) => setNext(e.target.value)}
          className="field w-full"
        />
      </label>
      <Notice feedback={feedback} />
      <button type="submit" disabled={busy} className="btn mt-4 w-full justify-center sm:w-auto">
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function EmailSettings({
  email,
  verified,
  googleOnly,
}: {
  email: string;
  verified: boolean;
  googleOnly: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"resend" | "change" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function post(body: Record<string, string>, which: "resend" | "change") {
    setBusy(which);
    setFeedback(null);
    setDevLink(null);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({ kind: "error", text: data?.error ?? "That did not work." });
        return;
      }
      setFeedback({ kind: "ok", text: data.message ?? "Sent." });
      // Only ever present on a development server with no mail configured —
      // the route gates it on three conditions. It exists so the whole flow is
      // exercisable locally without an SMTP account.
      if (data.devLink) setDevLink(data.devLink);
      if (which === "change") {
        setNext("");
        setPassword("");
        setOpen(false);
      }
      router.refresh();
    } catch {
      setFeedback({ kind: "error", text: "We could not reach the server." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm">{email}</span>
        <span
          className="rounded px-2 py-0.5 font-mono text-[10px] tracking-[0.12em] uppercase"
          style={{
            background: "var(--surface-2)",
            color: verified ? "var(--brand)" : "var(--warn)",
          }}
        >
          {verified ? "confirmed" : "not confirmed"}
        </span>
      </div>

      {!verified && (
        <p className="text-muted mt-2 text-sm leading-relaxed">
          Grindly works either way — nothing is locked. Confirming means we can
          actually reach you if you ever need to reset your password, which is the
          one moment an unreachable address costs you the account.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-3">
        {!verified && (
          <button
            onClick={() => post({}, "resend")}
            disabled={busy !== null}
            className="btn text-sm"
          >
            {busy === "resend" ? "Sending…" : "Send me the link"}
          </button>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={busy !== null}
          className="btn text-sm"
        >
          {open ? "Cancel" : "Use a different address"}
        </button>
      </div>

      {open && (
        <div className="border-border mt-4 border-t pt-4">
          <p className="text-muted text-sm leading-relaxed">
            We send a confirmation to the new address and a notice to this one.
            Nothing changes until you open the link, so a typo costs you nothing.
          </p>
          <label className="mt-3 block">
            <span className="mb-1.5 block text-sm font-medium">New email address</span>
            <input
              type="email"
              value={next}
              autoComplete="email"
              onChange={(e) => setNext(e.target.value)}
              className="field w-full"
              placeholder="you@example.com"
            />
          </label>
          {!googleOnly && (
            <label className="mt-3 block">
              <span className="mb-1.5 block text-sm font-medium">Your password</span>
              <input
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
                className="field w-full"
              />
            </label>
          )}
          <button
            onClick={() => post({ email: next, password }, "change")}
            disabled={busy !== null || next.trim().length < 5}
            className="btn btn-primary mt-4 text-sm"
          >
            {busy === "change" ? "Sending…" : "Send the confirmation"}
          </button>
        </div>
      )}

      <Notice feedback={feedback} />
      {devLink && (
        <p className="text-muted mt-2 text-xs">
          No mail server on this development machine, so here is the link:{" "}
          <a href={devLink} className="text-brand underline">
            {devLink}
          </a>
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ExportData() {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  /**
   * Fetched and saved from script rather than being a plain link.
   *
   * A link would work, but it gives no indication that anything is happening
   * while the server reads every PDF in the account off disk — and a rate-limit
   * refusal would render as a JSON blob in a new tab.
   */
  async function download() {
    setBusy(true);
    setFeedback(null);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFeedback({ kind: "error", text: data?.error ?? "The export did not work." });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `grindly-export-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoked on the next tick, not immediately: some browsers have not
      // started reading the blob by the time click() returns.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setFeedback({ kind: "ok", text: "Downloaded." });
    } catch {
      setFeedback({ kind: "error", text: "We could not reach the server." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <p className="text-muted text-sm leading-relaxed">
        One zip: every resume as you uploaded it, every rebuilt PDF, and a JSON file
        with every score, finding and fidelity count we have ever computed for you.
        Nothing about anyone else.
      </p>
      <button onClick={download} disabled={busy} className="btn mt-4 w-full justify-center sm:w-auto">
        {busy ? "Building your export…" : "Download everything"}
      </button>
      <Notice feedback={feedback} />
    </div>
  );
}
