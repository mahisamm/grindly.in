"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageTitle, Panel, Badge, fmtDate } from "../ui";

type Resp = {
  summary: Record<string, number>;
  integrations: { userId: string | null; email: string; platform: string; status: string; connectedAt: string | null; updatedAt: string }[];
};

export default function AdminIntegrations() {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/admin/integrations")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load."));
  }, []);

  if (err) return <p className="font-sans text-sm text-brand">{err}</p>;
  if (!d) return <p className="font-sans text-sm text-muted">Loading…</p>;

  return (
    <>
      <PageTitle title="Integrations" sub="needs-login sessions bubble to the top — those block the agent from applying" />

      <div className="mb-6 flex flex-wrap gap-2 font-sans text-xs">
        {Object.entries(d.summary).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5"><Badge value={k} /> <span className="tabular-nums">{v}</span></span>
        ))}
        {Object.keys(d.summary).length === 0 && <span className="text-muted">No integration records.</span>}
      </div>

      <Panel>
        <table className="w-full text-left font-sans text-xs">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Platform</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Connected</th>
              <th className="px-4 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {d.integrations.map((i, idx) => (
              <tr key={idx} className="border-b border-surface-2 hover:bg-surface-2">
                <td className="px-4 py-2">
                  {i.userId ? <Link href={`/admin/users/${i.userId}`} className="text-brand hover:underline">{i.email}</Link> : i.email}
                </td>
                <td className="px-4 py-2">{i.platform}</td>
                <td className="px-4 py-2"><Badge value={i.status} /></td>
                <td className="px-4 py-2 text-muted">{fmtDate(i.connectedAt)}</td>
                <td className="px-4 py-2 text-muted">{fmtDate(i.updatedAt)}</td>
              </tr>
            ))}
            {d.integrations.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">No integrations yet.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
