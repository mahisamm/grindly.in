"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageTitle, Panel, Badge, fmtDate } from "../ui";

type App = {
  id: string; jobTitle: string; company: string; matchScore: number; status: string;
  failureReason: string | null; outcome: string | null; appliedAt: string | null; createdAt: string;
  user: { id: string; email: string };
  job: { source: string } | null;
};
type Resp = { page: number; totalPages: number; total: number; applications: App[] };

const STATUSES = ["", "applied", "failed", "skipped", "matched", "needs_review", "submitting"];
const PLATFORMS = ["", "internshala", "linkedin", "naukri", "unstop", "indeed"];

export default function AdminApplications() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      const params = new URLSearchParams({ page: String(page) });
      if (q.trim()) params.set("q", q.trim());
      if (status) params.set("status", status);
      if (platform) params.set("platform", platform);
      fetch(`/api/admin/applications?${params}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then(setData)
        .catch(() => setErr("Failed to load."));
    }, 200);
    return () => clearTimeout(t);
  }, [q, status, platform, page]);

  return (
    <>
      <PageTitle title="All applications" sub={data ? `${data.total} total across all users` : undefined} />

      <div className="mb-4 flex flex-wrap gap-2">
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder="search job, company, email…"
          className="w-full max-w-xs rounded border border-[#262a33] bg-[#15171c] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none placeholder:text-[#5a606b] focus:border-[#ff4d4d]"
        />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="rounded border border-[#262a33] bg-[#15171c] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none focus:border-[#ff4d4d]"
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}
        </select>
        <select
          value={platform}
          onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
          className="rounded border border-[#262a33] bg-[#15171c] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none focus:border-[#ff4d4d]"
        >
          {PLATFORMS.map((p) => <option key={p} value={p}>{p || "all platforms"}</option>)}
        </select>
      </div>

      {err && <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>}

      <Panel>
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-[#5a606b]">
            <tr className="border-b border-[#262a33]">
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Job</th>
              <th className="px-4 py-2 font-medium">Platform</th>
              <th className="px-4 py-2 font-medium text-right">Score</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Outcome</th>
              <th className="px-4 py-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {data?.applications.map((a) => (
              <tr key={a.id} className="border-b border-[#1d2027] hover:bg-[#1a1d23]">
                <td className="px-4 py-2">
                  <Link href={`/admin/users/${a.user.id}`} className="text-[#9db4ff] hover:underline">
                    {a.user.email}
                  </Link>
                </td>
                <td className="max-w-[180px] truncate px-4 py-2" title={a.jobTitle}>
                  {a.jobTitle}
                  <span className="text-[#5a606b]"> · {a.company}</span>
                </td>
                <td className="px-4 py-2 text-[#8b919c]">{a.job?.source ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{a.matchScore}</td>
                <td className="px-4 py-2">
                  <Badge value={a.status} />
                  {a.failureReason && <span className="ml-1 text-[#ff4d4d] text-[10px]">{a.failureReason}</span>}
                </td>
                <td className="px-4 py-2 text-[#8b919c]">{a.outcome ?? "—"}</td>
                <td className="px-4 py-2 text-[#5a606b]">{fmtDate(a.appliedAt ?? a.createdAt)}</td>
              </tr>
            ))}
            {data && data.applications.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-[#8b919c]">No applications match.</td></tr>
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
