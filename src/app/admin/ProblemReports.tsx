"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * What users typed when something went wrong.
 *
 * Open reports first, because this list is a queue. Resolving is one press and
 * is reversible — the row stays, greyed, so a report closed by mistake is not
 * lost and a fault that comes back can be reopened rather than re-reported by
 * the next person to hit it.
 */

export type ReportRow = {
  id: string;
  message: string;
  path: string | null;
  resumeId: string | null;
  email: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export function ProblemReports({ reports }: { reports: ReportRow[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setResolved(id: string, resolved: boolean) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/problems/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved }),
      });
      if (!res.ok) {
        setError("Could not update that report.");
        return;
      }
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  if (reports.length === 0) {
    return (
      <p className="text-muted mt-3 text-sm">
        Nothing reported. The widget sits in the corner of every signed-in page.
      </p>
    );
  }

  return (
    <>
      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-3">
        {reports.map((r) => {
          const open = !r.resolvedAt;
          return (
            <li
              key={r.id}
              className="bg-surface rounded-lg border p-4"
              style={{
                borderColor: open ? "var(--warn)" : "var(--border)",
                borderLeftWidth: 3,
                opacity: open ? 1 : 0.62,
              }}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{r.message}</p>

              <div className="text-muted mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tracking-[0.08em] uppercase">
                <span>{r.email ?? "account deleted"}</span>
                <span>
                  {new Date(r.createdAt).toLocaleString("en-IN", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                {r.path && <span className="max-w-[16rem] truncate">{r.path}</span>}
                {/* The resume they were looking at, as a link. This is what
                    turns "the rewrite was wrong" into something openable. */}
                {r.resumeId && (
                  <a href={`/app/${r.resumeId}`} className="text-brand underline">
                    open the resume
                  </a>
                )}
              </div>

              <button
                onClick={() => void setResolved(r.id, open)}
                disabled={busy === r.id}
                className="text-muted hover:text-ink mt-3 cursor-pointer text-xs underline"
              >
                {busy === r.id ? "…" : open ? "Mark resolved" : "Reopen"}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
