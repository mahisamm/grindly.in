"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { PageTitle, Panel, StatCard, Badge, WeekTable, fmtDate } from "./ui";

type Overview = {
  users: { total: number; active: number; paused: number; paid: number; free: number; admins: number;
    byPlan: { free: number; plus: number; pro: number } };
  runs: { matched: number; applied: number; failed: number; failRate: number; appliedToday: number; windowDays: number; allTimeApplied: number };
  trend: { date: string; count: number }[];
  integrationHealth: { connected: number; needsLogin: number; disconnected: number; connecting: number };
  platformStats: { platform: string; applied: number; failed: number; failRate: number }[];
  cronHealth: { lastRunAt: string; status: string; mode: string; error: string | null; staleHours: number } | null;
  recentFailures: { id: string; userId: string | null; email: string; jobTitle: string; company: string; reason: string; createdAt: string }[];
};

export default function AdminOverview() {
  const [d, setD] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(() => {
    fetch("/api/health").then((r) => r.ok ? r.json() : null).then(setHealth).catch(() => {});
    fetch("/api/admin/overview")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((data) => { setD(data); setLastRefresh(new Date()); })
      .catch(() => setErr("Failed to load."));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  if (err) return <p className="font-sans text-sm text-brand">{err}</p>;
  if (!d) return <p className="font-sans text-sm text-muted">Loading…</p>;

  const cronOk = d.cronHealth && d.cronHealth.status === "done" && d.cronHealth.staleHours < 25;
  const cronWarn = d.cronHealth && (d.cronHealth.staleHours >= 25 || d.cronHealth.status === "failed");

  return (
    <>
      <div className="mb-6 flex items-start justify-between">
        <PageTitle title="Fleet overview" sub={`Run metrics over the last ${d.runs.windowDays} days · auto-refresh 60s`} />
        {lastRefresh && (
          <span className="font-sans text-[11px] text-muted">
            refreshed {lastRefresh.toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Hero numbers */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <Panel className="px-6 py-5">
          <div className="font-sans text-[11px] uppercase tracking-wide text-muted">Active subscribers</div>
          <div className="mt-1 font-sans text-5xl font-bold tabular-nums text-accent">{d.users.active}</div>
          <div className="mt-1 font-sans text-xs text-muted">{d.users.total} total · {d.users.paused} paused · {d.users.paid} paid</div>
        </Panel>
        <Panel className="px-6 py-5">
          <div className="font-sans text-[11px] uppercase tracking-wide text-muted">Successful applications</div>
          <div className="mt-1 font-sans text-5xl font-bold tabular-nums text-foreground">{d.runs.allTimeApplied}</div>
          <div className="mt-1 font-sans text-xs text-muted">+{d.runs.appliedToday} today · {d.runs.applied} in 14d · {d.runs.failRate}% fail rate</div>
        </Panel>
      </div>

      {/* Secondary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-6">
        <StatCard label="Applied today" value={d.runs.appliedToday} tone="good" />
        <StatCard label="Applied (14d)" value={d.runs.applied} />
        <StatCard label="Fail rate" value={`${d.runs.failRate}%`} tone={d.runs.failRate > 20 ? "bad" : d.runs.failRate > 10 ? "warn" : "good"} hint={`${d.runs.failed} failed`} />
        <StatCard label="Need login" value={d.integrationHealth.needsLogin} tone={d.integrationHealth.needsLogin > 0 ? "warn" : "default"} />
      </div>

      {/* Cron health */}
      {d.cronHealth && (
        <Panel className="mt-4 px-4 py-3">
          <div className="flex items-center gap-3 font-sans text-xs">
            <span className="uppercase tracking-wide text-muted">Last agent run</span>
            <Badge value={d.cronHealth.status} />
            <span className="text-muted">{fmtDate(d.cronHealth.lastRunAt)}</span>
            {cronOk && <span className="text-accent">✓ on schedule</span>}
            {cronWarn && <span className="text-warn">⚠ {d.cronHealth.staleHours}h ago — check cron</span>}
            {d.cronHealth.error && <span className="text-brand">error: {d.cronHealth.error}</span>}
            <Link href="/admin/agent-health" className="ml-auto text-brand hover:underline">
              run diagnostics →
            </Link>
          </div>
        </Panel>
      )}
      {!d.cronHealth && (
        <Panel className="mt-4 px-4 py-3">
          <div className="flex items-center justify-between font-sans text-xs text-muted">
            <span>No agent runs yet.</span>
            <Link href="/admin/agent-health" className="text-brand hover:underline">run diagnostics →</Link>
          </div>
        </Panel>
      )}

      {/* 7-day table */}
      <Panel className="mt-6 p-4">
        <div className="mb-3 font-sans text-[11px] uppercase tracking-wide text-muted">Applications · last 7 days</div>
        <WeekTable data={d.trend} />
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        {/* Recent failures */}
        <Panel className="lg:col-span-2">
          <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">Recent failures</div>
          {d.recentFailures.length === 0 ? (
            <p className="px-4 py-6 font-sans text-sm text-muted">No failures. Clean.</p>
          ) : (
            <table className="w-full text-left font-sans text-xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">User</th>
                  <th className="px-4 py-2 font-medium">Job</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {d.recentFailures.map((f) => (
                  <tr key={f.id} className="border-b border-surface-2 hover:bg-surface-2">
                    <td className="px-4 py-2">
                      {f.userId ? (
                        <Link href={`/admin/users/${f.userId}`} className="text-brand hover:underline">{f.email}</Link>
                      ) : f.email}
                    </td>
                    <td className="px-4 py-2 text-muted">{f.company}</td>
                    <td className="px-4 py-2"><Badge value={f.reason} /></td>
                    <td className="px-4 py-2 text-muted">{fmtDate(f.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        {/* Right column */}
        <div className="flex flex-col gap-6">
          <Panel className="p-4">
            <div className="mb-3 font-sans text-sm font-bold">Integration health</div>
            <ul className="space-y-2 font-sans text-xs">
              <li className="flex justify-between"><span className="text-muted">connected</span><span className="text-accent">{d.integrationHealth.connected}</span></li>
              <li className="flex justify-between"><span className="text-muted">needs login</span><span className="text-warn">{d.integrationHealth.needsLogin}</span></li>
              <li className="flex justify-between"><span className="text-muted">connecting</span><span className="text-warn">{d.integrationHealth.connecting}</span></li>
              <li className="flex justify-between"><span className="text-muted">disconnected</span><span className="text-muted">{d.integrationHealth.disconnected}</span></li>
            </ul>
            <div className="mt-4 border-t border-border pt-3 font-sans text-xs">
              <div className="mb-2 text-muted">plan mix</div>
              <div className="flex justify-between"><span>free</span><span>{d.users.byPlan.free}</span></div>
              <div className="flex justify-between"><span>plus</span><span>{d.users.byPlan.plus}</span></div>
              <div className="flex justify-between"><span>pro</span><span>{d.users.byPlan.pro}</span></div>
            </div>
          </Panel>

          {/* Per-platform fail rates */}
          {d.platformStats.length > 0 && (
            <Panel className="p-4">
              <div className="mb-3 font-sans text-sm font-bold">Platform fail rates · 14d</div>
              <ul className="space-y-2 font-sans text-xs">
                {d.platformStats.map((p) => (
                  <li key={p.platform} className="flex items-center justify-between gap-2">
                    <span className="text-muted capitalize">{p.platform}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-muted">{p.applied}✓ {p.failed}✗</span>
                      <span className={p.failRate > 20 ? "text-brand" : p.failRate > 10 ? "text-warn" : "text-accent"}>
                        {p.failRate}%
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

      {/* System status */}
      {health && (
        <div className="mt-6">
          <Panel className="p-5">
            <div className="mb-3 font-sans text-sm font-bold text-muted uppercase tracking-wide">System status</div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {([
                { label: "Database", ok: !!(health as {checks?: {db?: {ok: boolean}}}).checks?.db?.ok, link: null },
                { label: "Email", ok: !!(health as {services?: {email: boolean}}).services?.email, link: "/admin/settings" },
                { label: "LLM", ok: !!(health as {services?: {llm: boolean}}).services?.llm, link: null },
                { label: "Google OAuth", ok: !!(health as {services?: {googleOAuth: boolean}}).services?.googleOAuth, link: null },
              ] as { label: string; ok: boolean; link: string | null }[]).map(({ label, ok, link }) => (
                <div key={label} className="flex items-center gap-2 rounded bg-surface-2/60 px-3 py-2">
                  <span className={`h-2 w-2 rounded-full ${ok ? "bg-accent" : "bg-brand"}`} />
                  <span className="text-xs text-muted">{label}</span>
                  {!ok && link && (
                    <Link href={link} className="ml-auto text-[10px] text-brand hover:underline">fix</Link>
                  )}
                </div>
              ))}
            </div>
            {((health as {missing?: string[]}).missing ?? []).length > 0 && (
              <div className="mt-3">
                <div className="text-[11px] uppercase tracking-wide text-brand mb-1">Missing config</div>
                <ul className="space-y-0.5">
                  {((health as {missing?: string[]}).missing ?? []).map((m, i) => (
                    <li key={i} className="font-sans text-xs text-brand/80">{m}</li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>
        </div>
      )}
      </div>
    </>
  );
}
