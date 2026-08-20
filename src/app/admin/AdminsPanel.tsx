"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type AdminRow = { id: string; email: string };

/**
 * Who else can see this page.
 *
 * Deliberately spare: an email box and a list, because the two failure modes
 * this needs to avoid are "granted admin to a typo" (the account has to exist
 * already — see api/admin/admins) and "revoked the last admin" (the API
 * refuses that outright, and the button here just surfaces what it said).
 */
export function AdminsPanel({ admins, selfId }: { admins: AdminRow[]; selfId: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function grant() {
    const value = email.trim();
    if (!value) return;
    setBusy("grant");
    setError(null);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work.");
        return;
      }
      setEmail("");
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/admins/${id}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "That did not work.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="bg-surface border-border mt-3 rounded-xl border p-5">
      {error && (
        <p role="alert" className="mb-3 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email of an existing account"
          className="border-border bg-page min-w-0 flex-1 rounded-lg border px-3 py-1.5 text-sm"
        />
        <button
          onClick={() => void grant()}
          disabled={busy !== null || !email.trim()}
          className="btn btn-primary text-xs"
        >
          {busy === "grant" ? "…" : "Grant admin"}
        </button>
      </div>

      <ul className="mt-4 flex flex-col gap-2">
        {admins.map((a) => (
          <li
            key={a.id}
            className="border-border flex items-center justify-between gap-3 rounded-lg border p-2.5"
            style={{ opacity: busy === a.id ? 0.6 : 1 }}
          >
            <span className="truncate text-sm">
              {a.email}
              {a.id === selfId && <span className="text-muted"> · you</span>}
            </span>
            <button
              onClick={() => void revoke(a.id)}
              disabled={busy !== null || admins.length <= 1}
              className="text-muted hover:text-ink cursor-pointer text-xs underline disabled:cursor-not-allowed disabled:opacity-50"
              title={admins.length <= 1 ? "The last admin cannot be revoked." : undefined}
            >
              {busy === a.id ? "…" : "Revoke"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
