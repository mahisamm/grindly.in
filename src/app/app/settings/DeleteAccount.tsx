"use client";

import { useState } from "react";

/**
 * Type your own email to delete the account.
 *
 * The confirmation is the email rather than a checkbox because this is
 * irreversible and there is nothing to restore afterwards. The server checks
 * the same string, so a scripted POST cannot skip the step either.
 */
export function DeleteAccount({ email }: { email: string }) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matches = confirm.trim().toLowerCase() === email.toLowerCase();

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not delete the account.");
        setBusy(false);
        return;
      }
      // Full navigation: the session cookie is gone and every server component
      // needs to re-render without it.
      window.location.href = "/";
    } catch {
      setError("We could not reach the server.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-5">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">
          Type <b>{email}</b> to confirm
        </span>
        <input
          type="text"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="off"
          className="field w-full max-w-sm"
          placeholder={email}
        />
      </label>
      <button
        onClick={remove}
        disabled={!matches || busy}
        className="mt-4 rounded px-4 py-2 text-sm font-medium disabled:opacity-40"
        style={{ background: "#a3271b", color: "var(--paper)" }}
      >
        {busy ? "Deleting…" : "Delete my account permanently"}
      </button>
      {error && (
        <p role="alert" className="mt-2 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
    </div>
  );
}
