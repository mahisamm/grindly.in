"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageTitle, Panel, Badge, fmtDate, TableWrap } from "../ui";

type Row = {
  id: string; email: string; name: string | null; role: string; plan: string;
  paid: boolean; status: string; createdAt: string; applications: number;
};
type Resp = { page: number; totalPages: number; total: number; users: Row[] };

export default function AdminUsers() {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const id = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page) });
      if (q.trim()) params.set("q", q.trim());
      fetch(`/api/admin/users?${params}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then(setData)
        .catch(() => setErr("Failed to load."));
    }, 200);
    return () => clearTimeout(id);
  }, [q, page]);

  return (
    <>
      <PageTitle title="Users" sub={data ? `${data.total} accounts` : undefined} />

      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setPage(1); }}
        placeholder="search email or name…"
        className="mb-4 w-full max-w-sm rounded border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground outline-none placeholder:text-muted focus:border-brand"
      />

      {err && <p className="font-sans text-sm text-brand">{err}</p>}

      <Panel>
        <TableWrap min="min-w-[720px]">
          <table className="w-full text-left font-sans text-xs">
            <thead className="text-muted">
              <tr className="border-b border-border">
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Plan</th>
                <th className="px-4 py-2 font-medium">Role</th>
                <th className="px-4 py-2 font-medium text-right">Apps</th>
                <th className="px-4 py-2 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {data?.users.map((u) => (
                <tr key={u.id} className="border-b border-surface-2 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    <Link href={`/admin/users/${u.id}`} className="text-brand hover:underline">{u.email}</Link>
                    {u.name && <span className="ml-2 text-muted">{u.name}</span>}
                  </td>
                  <td className="px-4 py-2"><Badge value={u.status} /></td>
                  <td className="px-4 py-2">{u.plan}{u.paid ? "" : <span className="text-muted"> (unpaid)</span>}</td>
                  <td className="px-4 py-2">{u.role === "admin" ? <Badge value="admin" /> : <span className="text-muted">user</span>}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{u.applications}</td>
                  <td className="px-4 py-2 text-muted">{fmtDate(u.createdAt)}</td>
                </tr>
              ))}
              {data && data.users.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-muted">No users match.</td></tr>
              )}
            </tbody>
          </table>
        </TableWrap>
      </Panel>

      {data && data.totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 font-sans text-xs">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:enabled:bg-surface-2">← prev</button>
          <span className="text-muted">{page} / {data.totalPages}</span>
          <button disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:enabled:bg-surface-2">next →</button>
        </div>
      )}
    </>
  );
}
