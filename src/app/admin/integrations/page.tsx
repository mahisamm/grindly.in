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

  if (err) return <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>;
  if (!d) return <p className="font-mono text-sm text-[#8b919c]">Loading…</p>;

  return (
    <>
      <PageTitle title="Integrations" sub="needs-login sessions bubble to the top — those block the agent from applying" />

      <div className="mb-6 flex flex-wrap gap-2 font-mono text-xs">
        {Object.entries(d.summary).map(([k, v]) => (
          <span key={k} className="flex items-center gap-1.5"><Badge value={k} /> <span className="tabular-nums">{v}</span></span>
        ))}
        {Object.keys(d.summary).length === 0 && <span className="text-[#8b919c]">No integration records.</span>}
      </div>

      <Panel>
        <table className="w-full text-left font-mono text-xs">
          <thead className="text-[#5a606b]">
            <tr className="border-b border-[#262a33]">
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Platform</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Connected</th>
              <th className="px-4 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {d.integrations.map((i, idx) => (
              <tr key={idx} className="border-b border-[#1d2027] hover:bg-[#1a1d23]">
                <td className="px-4 py-2">
                  {i.userId ? <Link href={`/admin/users/${i.userId}`} className="text-[#9db4ff] hover:underline">{i.email}</Link> : i.email}
                </td>
                <td className="px-4 py-2">{i.platform}</td>
                <td className="px-4 py-2"><Badge value={i.status} /></td>
                <td className="px-4 py-2 text-[#5a606b]">{fmtDate(i.connectedAt)}</td>
                <td className="px-4 py-2 text-[#5a606b]">{fmtDate(i.updatedAt)}</td>
              </tr>
            ))}
            {d.integrations.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-[#8b919c]">No integrations yet.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
