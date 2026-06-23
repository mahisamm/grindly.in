"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { PageTitle, Panel, StatCard, Badge, BarTrend, fmtDate } from "./ui";

type Overview = {
  users: { total: number; active: number; paused: number; paid: number; free: number; admins: number;
    byPlan: { free: number; starter: number; pro: number } };
  runs: { matched: number; applied: number; failed: number; failRate: number; appliedToday: number; windowDays: number };
  trend: { date: string; count: number }[];
  integrationHealth: { connected: number; needsLogin: number; disconnected: number; connecting: number };
  recentFailures: { id: string; userId: string | null; email: string; jobTitle: string; company: string; reason: string; createdAt: string }[];
};

export default function AdminOverview() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/admin/overview")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load."));
  }, []);

  if (err) return <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>;
  if (!d) return <p className="font-mono text-sm text-[#8b919c]">Loading…</p>;

  return (
    <>
      <PageTitle title="Fleet overview" sub={`Run metrics over the last ${d.runs.windowDays} days · live`} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Users" value={d.users.total} hint={`${d.users.paid} paid · ${d.users.free} free`} />
        <StatCard label="Active" value={d.users.active} tone="good" hint={`${d.users.paused} paused`} />
        <StatCard label="Applied today" value={d.runs.appliedToday} tone="good" />
        <StatCard label="Applied (14d)" value={d.runs.applied} />
        <StatCard label="Fail rate" value={`${d.runs.failRate}%`} tone={d.runs.failRate > 20 ? "bad" : d.runs.failRate > 10 ? "warn" : "good"} hint={`${d.runs.failed} failed`} />
        <StatCard label="Need login" value={d.integrationHealth.needsLogin} tone={d.integrationHealth.needsLogin > 0 ? "warn" : "default"} />
      </div>

      <Panel className="mt-6 p-4">
        <div className="mb-2 font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">Applied per day · 14d</div>
        <BarTrend data={d.trend} />
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <div className="border-b border-[#262a33] px-4 py-3 font-mono text-sm font-bold">Recent failures</div>
          {d.recentFailures.length === 0 ? (
            <p className="px-4 py-6 font-mono text-sm text-[#8b919c]">No failures. Clean.</p>
          ) : (
            <table className="w-full text-left font-mono text-xs">
              <thead className="text-[#5a606b]">
                <tr className="border-b border-[#262a33]">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {d.recentFailures.map((f) => (
                  <tr key={f.id} className="border-b border-[#1d2027] hover:bg-[#1a1d23]">
                    <td className="px-4 py-2">
                      {f.userId ? (
                        <Link href={`/admin/users/${f.userId}`} className="text-[#9db4ff] hover:underline">{f.email}</Link>
                      ) : f.email}
                    </td>
                    <td className="px-4 py-2 text-[#8b919c]">{f.company}</td>
                    <td className="px-4 py-2"><Badge value={f.reason} /></td>
                    <td className="px-4 py-2 text-[#5a606b]">{fmtDate(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel className="p-4">
          <div className="mb-3 font-mono text-sm font-bold">Integration health</div>
          <ul className="space-y-2 font-mono text-xs">
            <li className="flex justify-between"><span className="text-[#8b919c]">connected</span><span className="text-[#36d399]">{d.integrationHealth.connected}</span></li>
            <li className="flex justify-between"><span className="text-[#8b919c]">needs login</span><span className="text-[#fbbd23]">{d.integrationHealth.needsLogin}</span></li>
            <li className="flex justify-between"><span className="text-[#8b919c]">connecting</span><span className="text-[#fbbd23]">{d.integrationHealth.connecting}</span></li>
            <li className="flex justify-between"><span className="text-[#8b919c]">disconnected</span><span className="text-[#5a606b]">{d.integrationHealth.disconnected}</span></li>
          </ul>
          <div className="mt-4 border-t border-[#262a33] pt-3 font-mono text-xs">
            <div className="mb-2 text-[#8b919c]">plan mix</div>
            <div className="flex justify-between"><span>free</span><span>{d.users.byPlan.free}</span></div>
            <div className="flex justify-between"><span>starter</span><span>{d.users.byPlan.starter}</span></div>
            <div className="flex justify-between"><span>pro</span><span>{d.users.byPlan.pro}</span></div>
          </div>
        </Panel>
      </div>
    </>
  );
}
