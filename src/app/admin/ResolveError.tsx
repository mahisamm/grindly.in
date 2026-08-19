"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Mark one error as dealt with.
 *
 * Deliberately not a confirmation dialog: resolving is cheap and reversible —
 * the row is not deleted, and the same fault firing again clears the flag and
 * puts it straight back on this page. The only thing worth guarding against is
 * a double click, which `busy` covers.
 */
export function ResolveError({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function resolve() {
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/admin/errors/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: true }),
      });
      if (!res.ok) {
        setFailed(true);
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  if (failed) {
    return (
      <button onClick={resolve} className="text-xs underline" style={{ color: "#a3271b" }}>
        Failed — retry
      </button>
    );
  }

  return (
    <button
      onClick={resolve}
      disabled={busy}
      className="text-muted hover:text-ink cursor-pointer text-xs underline"
    >
      {busy ? "Resolving…" : "Resolve"}
    </button>
  );
}
