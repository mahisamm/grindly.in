"use client";

import { useEffect, useState } from "react";
import { PageTitle, Panel, Badge, fmtDate } from "../ui";

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
        className="mb-4 w-full max-w-sm rounded border border-[#262a33] bg-[#15171c] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none placeholder:text-[#5a606b] focus:border-[#ff4d4d]"
      />

      {err && <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>}

      <Panel>
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-[#5a606b]">
            <tr className="border-b border-[#262a33]">
              <th className="px-4 py-2 font-medium">Action</th>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Target</th>
              <th className="px-4 py-2 font-medium">Detail</th>
              <th className="px-4 py-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {d?.logs.map((l) => (
              <tr key={l.id} className="border-b border-[#1d2027] hover:bg-[#1a1d23]">
                <td className="px-4 py-2">{l.action.startsWith("admin_") ? <Badge value="admin" /> : null} <span className="text-[#9db4ff]">{l.action}</span></td>
                <td className="px-4 py-2 text-[#8b919c]">{l.email ?? "—"}</td>
                <td className="max-w-[180px] truncate px-4 py-2 text-[#8b919c]" title={l.target ?? ""}>{l.target ?? "—"}</td>
                <td className="max-w-[240px] truncate px-4 py-2 text-[#5a606b]" title={l.detail ?? ""}>{l.detail ?? "—"}</td>
                <td className="px-4 py-2 text-[#5a606b]">{fmtDate(l.createdAt)}</td>
              </tr>
            ))}
            {d && d.logs.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-[#8b919c]">No entries match.</td></tr>}
          </tbody>
        </table>
      </Panel>

      {d && d.totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 font-mono text-xs">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="rounded border border-[#262a33] px-3 py-1 disabled:opacity-40 hover:enabled:bg-[#1d2027]">← prev</button>
          <span className="text-[#8b919c]">{page} / {d.totalPages}</span>
          <button disabled={page >= d.totalPages} onClick={() => setPage((p) => p + 1)}
            className="rounded border border-[#262a33] px-3 py-1 disabled:opacity-40 hover:enabled:bg-[#1d2027]">next →</button>
        </div>
      )}
    </>
  );
}
