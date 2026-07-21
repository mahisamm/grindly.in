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
          className="w-full max-w-xs rounded border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground outline-none placeholder:text-muted focus:border-brand"
        />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
          className="rounded border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-brand"
        >
          {STATUSES.map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}
        </select>
        <select
          value={platform}
          onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
          className="rounded border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-brand"
        >
          {PLATFORMS.map((p) => <option key={p} value={p}>{p || "all platforms"}</option>)}
        </select>
      </div>

      {err && <p className="font-sans text-sm text-brand">{err}</p>}
      {!err && !data && <p className="font-sans text-sm text-muted">Loading…</p>}

      {data && <Panel>
        <table className="w-full text-left font-sans text-xs">
          <thead className="text-muted">
            <tr className="border-b border-border">
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
              <tr key={a.id} className="border-b border-surface-2 hover:bg-surface-2">
                <td className="px-4 py-2">
                  <Link href={`/admin/users/${a.user.id}`} className="text-brand hover:underline">
                    {a.user.email}
                  </Link>
                </td>
                <td className="max-w-[180px] truncate px-4 py-2" title={a.jobTitle}>
                  {a.jobTitle}
                  <span className="text-muted"> · {a.company}</span>
                </td>
                <td className="px-4 py-2 text-muted">{a.job?.source ?? "—"}</td>
                <td className="px-4 py-2 text-right tabular-nums">{a.matchScore}</td>
                <td className="px-4 py-2">
                  <Badge value={a.status} />
                  {a.failureReason && <span className="ml-1 text-brand text-[10px]">{a.failureReason}</span>}
                </td>
                <td className="px-4 py-2 text-muted">{a.outcome ?? "—"}</td>
                <td className="px-4 py-2 text-muted">{fmtDate(a.appliedAt ?? a.createdAt)}</td>
              </tr>
            ))}
            {data && data.applications.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-muted">No applications match.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>}

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
