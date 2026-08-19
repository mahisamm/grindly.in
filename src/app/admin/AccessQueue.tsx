"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * The beta door, as one button per person.
 *
 * The whole design goal is that letting someone in is a single decision made
 * from a single screen: who they are, when they asked, one press. Anything that
 * makes the operator open a second tab to decide is a queue that stops being
 * worked.
 *
 * Approving is optimistic — the row greys out immediately — because the
 * alternative on a slow connection is an operator pressing the same button
 * twice and wondering which press counted.
 */

export type QueuedUser = {
  id: string;
  email: string;
  name: string | null;
  accessStatus: string;
  createdAt: string;
  approvedAt: string | null;
};

const NEXT_LABEL: Record<string, { label: string; status: string; tone: "go" | "stop" }[]> = {
  pending: [
    { label: "Approve", status: "approved", tone: "go" },
    { label: "Block", status: "blocked", tone: "stop" },
  ],
  approved: [{ label: "Revoke", status: "blocked", tone: "stop" }],
  blocked: [{ label: "Approve", status: "approved", tone: "go" }],
};

export function AccessQueue({ users, emptyNote }: { users: QueuedUser[]; emptyNote: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, status: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/access/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "That did not work.");
        return;
      }
      setDone((d) => ({ ...d, [id]: status }));
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(null);
    }
  }

  if (users.length === 0) {
    return <p className="text-muted mt-3 text-sm">{emptyNote}</p>;
  }

  return (
    <>
      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}
      <ul className="mt-3 flex flex-col gap-2">
        {users.map((u) => {
          const status = done[u.id] ?? u.accessStatus;
          const actions = NEXT_LABEL[status] ?? [];
          return (
            <li
              key={u.id}
              className="bg-surface border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              style={{ opacity: busy === u.id ? 0.6 : 1 }}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{u.email}</p>
                <p className="text-muted mt-0.5 font-mono text-[10px] tracking-[0.08em] uppercase">
                  {u.name ? `${u.name} · ` : ""}
                  asked {new Date(u.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                  })}
                  {status !== u.accessStatus ? ` · now ${status}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {actions.map((a) => (
                  <button
                    key={a.status}
                    onClick={() => void decide(u.id, a.status)}
                    disabled={busy !== null}
                    className={
                      a.tone === "go"
                        ? "btn btn-primary text-xs"
                        : "text-muted hover:text-ink cursor-pointer text-xs underline"
                    }
                  >
                    {busy === u.id ? "…" : a.label}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
