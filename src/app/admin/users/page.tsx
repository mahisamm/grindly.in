"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageTitle, Panel, Badge, fmtDate } from "../ui";

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
        className="mb-4 w-full max-w-sm rounded border border-[#262a33] bg-[#15171c] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none placeholder:text-[#5a606b] focus:border-[#ff4d4d]"
      />

      {err && <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>}

      <Panel>
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-[#5a606b]">
            <tr className="border-b border-[#262a33]">
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
              <tr key={u.id} className="border-b border-[#1d2027] hover:bg-[#1a1d23]">
                <td className="px-4 py-2">
                  <Link href={`/admin/users/${u.id}`} className="text-[#9db4ff] hover:underline">{u.email}</Link>
                  {u.name && <span className="ml-2 text-[#5a606b]">{u.name}</span>}
                </td>
                <td className="px-4 py-2"><Badge value={u.status} /></td>
                <td className="px-4 py-2">{u.plan}{u.paid ? "" : <span className="text-[#5a606b]"> (unpaid)</span>}</td>
                <td className="px-4 py-2">{u.role === "admin" ? <Badge value="admin" /> : <span className="text-[#5a606b]">user</span>}</td>
                <td className="px-4 py-2 text-right tabular-nums">{u.applications}</td>
                <td className="px-4 py-2 text-[#5a606b]">{fmtDate(u.createdAt)}</td>
              </tr>
            ))}
            {data && data.users.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-[#8b919c]">No users match.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>

      {data && data.totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 font-mono text-xs">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="rounded border border-[#262a33] px-3 py-1 disabled:opacity-40 hover:enabled:bg-[#1d2027]">← prev</button>
          <span className="text-[#8b919c]">{page} / {data.totalPages}</span>
          <button disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}
            className="rounded border border-[#262a33] px-3 py-1 disabled:opacity-40 hover:enabled:bg-[#1d2027]">next →</button>
        </div>
      )}
    </>
  );
}
