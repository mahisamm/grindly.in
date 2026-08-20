"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export type Switches = { signupsPaused: boolean; rebuildsPaused: boolean };

const ROWS: { key: keyof Switches; label: string; note: string; onNote: string }[] = [
  {
    key: "signupsPaused",
    label: "Pause new sign-ups",
    note: "New accounts (password or Google) are refused with a plain message. Existing accounts sign in as normal, and the owner email always gets through.",
    onNote: "Sign-ups are paused. New visitors cannot create an account.",
  },
  {
    key: "rebuildsPaused",
    label: "Pause rebuilds",
    note: "No new rebuild starts, for anyone — including admin. Use this immediately before a deploy or a database migration, and turn it off right after.",
    onNote: "Rebuilds are paused. Nobody can start a new one until this is off.",
  },
];

/**
 * Two switches, file-backed (see lib/adminSettings.ts) so flipping one cannot
 * itself fail because the database is having a bad night.
 */
export function SettingsSwitches({ initial }: { initial: Switches }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [busy, setBusy] = useState<keyof Switches | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: keyof Switches) {
    setBusy(key);
    setError(null);
    const next = !state[key];
    try {
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "That did not work.");
        return;
      }
      setState((s) => ({ ...s, [key]: next }));
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
      {ROWS.map((row) => {
        const on = state[row.key];
        return (
          <div key={row.key} className="bg-surface border-border rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold">{row.label}</p>
              <button
                onClick={() => void toggle(row.key)}
                disabled={busy !== null}
                aria-pressed={on}
                className="rounded-full border px-3 py-1 font-mono text-[10px] tracking-[0.1em] uppercase"
                style={
                  on
                    ? { background: "var(--warn)", color: "var(--on-cta)", borderColor: "var(--warn)" }
                    : { color: "var(--muted)", borderColor: "var(--line-2)" }
                }
              >
                {busy === row.key ? "…" : on ? "On" : "Off"}
              </button>
            </div>
            <p className="text-muted mt-1.5 text-xs leading-relaxed">{on ? row.onNote : row.note}</p>
          </div>
        );
      })}
    </div>
  );
}
