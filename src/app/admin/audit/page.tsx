"use client";

import { useEffect, useState } from "react";
import { PageTitle, Panel, Badge, fmtDate, TableWrap } from "../ui";

type Log = { id: string; action: string; target: string | null; detail: string | null; email: string | null; createdAt: string };
type Resp = { page: number; totalPages: number; total: number; logs: Log[] };

export default function AdminAudit() {
  const [action, setAction] = useState("");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page) });
      if (action.trim()) params.set("action", action.trim());
      fetch(`/api/admin/audit?${params}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then(setD)
        .catch(() => setErr("Failed to load."));
    }, 200);
    return () => clearTimeout(t);
  }, [action, page]);

  return (
    <>
      <PageTitle title="Audit log" sub={d ? `${d.total} entries · append-only` : undefined} />

      <input
        value={action}
        onChange={(e) => { setAction(e.target.value); setPage(1); }}
        placeholder="filter by action (e.g. login, apply, admin_pause)…"
        className="mb-4 w-full max-w-sm rounded border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground outline-none placeholder:text-muted focus:border-brand"
      />

      {err && <p className="font-sans text-sm text-brand">{err}</p>}
      {!err && !d && <p className="font-sans text-sm text-muted">Loading…</p>}

      {d && <Panel>
        <TableWrap min="min-w-[720px]">
          <table className="w-full text-left font-sans text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">User</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Detail</th>
                <th className="px-4 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {d?.logs.map((l) => (
                <tr key={l.id} className="border-b border-surface-2 hover:bg-surface-2">
                  <td className="px-4 py-2">{l.action.startsWith("admin_") ? <Badge value="admin" /> : null} <span className="text-brand">{l.action}</span></td>
                  <td className="px-4 py-2 text-muted">{l.email ?? "—"}</td>
                  <td className="max-w-[180px] truncate px-4 py-2 text-muted" title={l.target ?? ""}>{l.target ?? "—"}</td>
                  <td className="max-w-[240px] truncate px-4 py-2 text-muted" title={l.detail ?? ""}>{l.detail ?? "—"}</td>
                  <td className="px-4 py-2 text-muted">{fmtDate(l.createdAt)}</td>
                </tr>
              ))}
              {d && d.logs.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">No entries match.</td></tr>}
            </tbody>
          </table>
        </TableWrap>
      </Panel>}

      {d && d.totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 font-sans text-xs">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:enabled:bg-surface-2">← prev</button>
          <span className="text-muted">{page} / {d.totalPages}</span>
          <button disabled={page >= d.totalPages} onClick={() => setPage((p) => p + 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:enabled:bg-surface-2">next →</button>
        </div>
      )}
    </>
  );
}
