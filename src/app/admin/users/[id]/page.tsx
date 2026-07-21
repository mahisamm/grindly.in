"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageTitle, Panel, StatCard, Badge, fmtDate } from "../../ui";

type Detail = {
  user: { id: string; email: string; name: string | null; role: string; plan: string;
    paid: boolean; status: string; phone: string | null; slackConnected: boolean;
    internshalaBetaAccess: boolean; createdAt: string };
  profile: null | {
    experienceLevel: string | null; skills: string; preferredDomains: string; preferredLocations: string;
    workMode: string; minMatchScore: number; stipendMin: number; autoApply: boolean; resumeScore: number | null; updatedAt: string;
  };
  integrations: { platform: string; status: string; connectedAt: string | null; updatedAt: string }[];
  stats: { total: number; applied: number; failed: number; skipped: number; interviews: number; offers: number };
  applications: { id: string; jobTitle: string; company: string; matchScore: number; status: string; outcome: string | null; failureReason: string | null; createdAt: string }[];
  reports: { date: string; matchedCount: number; appliedCount: number; failedCount: number }[];
  auditLogs: { id: string; action: string; target: string | null; detail: string | null; createdAt: string }[];
};

type Action =
  | { action: "pause" } | { action: "resume" }
  | { action: "set_paid"; value: boolean }
  | { action: "set_plan"; value: string }
  | { action: "set_role"; value: string }
  | { action: "set_integration_access"; value: boolean }
  | { action: "disconnect"; platform: string };

export default function AdminUserDetail() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/admin/users/${id}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load (not found or not authorized)."));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function act(a: Action, confirmMsg: string) {
    if (!window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/users/${id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(a),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error ?? "Action failed");
      } else {
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  if (err) return <p className="font-sans text-sm text-brand">{err}</p>;
  if (!d) return <p className="font-sans text-sm text-muted">Loading…</p>;

  const u = d.user;

  return (
    <>
      <Link href="/admin/users" className="font-sans text-xs text-muted hover:text-foreground">← all users</Link>
      <div className="mt-2">
        <PageTitle title={u.email} sub={`${u.name ?? "no name"} · joined ${fmtDate(u.createdAt)} · ${u.phone ?? "no phone"}`} />
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Badge value={u.status} />
        <Badge value={u.role === "admin" ? "admin" : "user"} />
        <span className="font-sans text-xs text-muted">plan: {u.plan} · {u.paid ? "paid" : "unpaid"}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total apps" value={d.stats.total} />
        <StatCard label="Applied" value={d.stats.applied} tone="good" />
        <StatCard label="Failed" value={d.stats.failed} tone={d.stats.failed > 0 ? "bad" : "default"} />
        <StatCard label="Skipped" value={d.stats.skipped} />
        <StatCard label="Interviews" value={d.stats.interviews} tone="good" />
        <StatCard label="Offers" value={d.stats.offers} tone="good" />
      </div>

      {/* Admin actions */}
      <Panel className="mt-6 p-4">
        <div className="mb-3 font-sans text-sm font-bold text-brand">Admin actions</div>
        <div className="flex flex-wrap gap-2 font-sans text-xs">
          {u.status === "paused" ? (
            <ActionBtn disabled={busy} onClick={() => act({ action: "resume" }, `Resume ${u.email}?`)}>resume</ActionBtn>
          ) : (
            <ActionBtn disabled={busy} danger onClick={() => act({ action: "pause" }, `Pause ${u.email}? Agent stops running for them.`)}>pause</ActionBtn>
          )}
          <ActionBtn disabled={busy} onClick={() => act({ action: "set_paid", value: !u.paid }, `Set paid=${!u.paid} for ${u.email}?`)}>
            {u.paid ? "mark unpaid" : "mark paid"}
          </ActionBtn>
          {(["free", "plus", "pro"] as const).map((p) => (
            <ActionBtn key={p} disabled={busy || u.plan === p} onClick={() => act({ action: "set_plan", value: p }, `Set plan=${p} for ${u.email}?`)}>plan: {p}</ActionBtn>
          ))}
          <ActionBtn disabled={busy} danger
            onClick={() => act({ action: "set_role", value: u.role === "admin" ? "user" : "admin" }, `Set role=${u.role === "admin" ? "user" : "admin"} for ${u.email}?`)}>
            {u.role === "admin" ? "revoke admin" : "grant admin"}
          </ActionBtn>
          <ActionBtn disabled={busy}
            onClick={() => act({ action: "set_integration_access", value: !u.internshalaBetaAccess }, `${u.internshalaBetaAccess ? "Revoke" : "Grant"} Internshala integration access for ${u.email}?`)}>
            {u.internshalaBetaAccess ? "revoke integration access" : "grant integration access"}
          </ActionBtn>
        </div>
        <p className="mt-2 font-sans text-[11px] text-muted">
          Integration access: <span className={u.internshalaBetaAccess ? "text-accent" : "text-muted"}>{u.internshalaBetaAccess ? "granted" : "not granted"}</span>
          {" "}— lets this user connect Internshala in the beta even when the global rollout is closed.
        </p>
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Integrations */}
        <Panel>
          <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">Integrations</div>
          {d.integrations.length === 0 ? (
            <p className="px-4 py-4 font-sans text-xs text-muted">None connected.</p>
          ) : (
            <ul className="divide-y divide-surface-2">
              {d.integrations.map((i) => (
                <li key={i.platform} className="flex items-center justify-between px-4 py-2 font-sans text-xs">
                  <span>{i.platform} <Badge value={i.status} /></span>
                  <div className="flex items-center gap-3">
                    <span className="text-muted">{fmtDate(i.connectedAt)}</span>
                    {i.status !== "disconnected" && (
                      <button disabled={busy} onClick={() => act({ action: "disconnect", platform: i.platform }, `Force-disconnect ${i.platform} for ${u.email}?`)}
                        className="text-brand hover:underline disabled:opacity-40">disconnect</button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Profile */}
        <Panel className="p-4">
          <div className="mb-3 font-sans text-sm font-bold">Profile</div>
          {d.profile ? (
            <dl className="grid grid-cols-2 gap-y-1.5 font-sans text-xs">
              <Field k="experience" v={d.profile.experienceLevel ?? "—"} />
              <Field k="work mode" v={d.profile.workMode} />
              <Field k="min score" v={String(d.profile.minMatchScore)} />
              <Field k="stipend min" v={`₹${d.profile.stipendMin}`} />
              <Field k="auto-apply" v={d.profile.autoApply ? "on" : "off"} />
              <Field k="resume score" v={d.profile.resumeScore == null ? "—" : String(d.profile.resumeScore)} />
            </dl>
          ) : (
            <p className="font-sans text-xs text-muted">No profile.</p>
          )}
        </Panel>
      </div>

      {/* Applications */}
      <Panel className="mt-6">
        <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">Recent applications ({d.applications.length})</div>
        <table className="w-full text-left font-sans text-xs">
          <thead className="text-muted">
            <tr className="border-b border-border">
              <th className="px-4 py-2 font-medium">Job</th>
              <th className="px-4 py-2 font-medium text-right">Score</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Outcome</th>
              <th className="px-4 py-2 font-medium">When</th>
            </tr>
          </thead>
          <tbody>
            {d.applications.map((a) => (
              <tr key={a.id} className="border-b border-surface-2">
                <td className="px-4 py-2">{a.jobTitle} <span className="text-muted">· {a.company}</span></td>
                <td className="px-4 py-2 text-right tabular-nums">{a.matchScore}</td>
                <td className="px-4 py-2"><Badge value={a.status} />{a.failureReason && <span className="ml-1 text-brand">{a.failureReason}</span>}</td>
                <td className="px-4 py-2 text-muted">{a.outcome ?? "—"}</td>
                <td className="px-4 py-2 text-muted">{fmtDate(a.createdAt)}</td>
              </tr>
            ))}
            {d.applications.length === 0 && <tr><td colSpan={5} className="px-4 py-4 text-center text-muted">No applications.</td></tr>}
          </tbody>
        </table>
      </Panel>

      {/* Audit */}
      <Panel className="mt-6">
        <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">Audit trail</div>
        <ul className="divide-y divide-surface-2">
          {d.auditLogs.map((l) => (
            <li key={l.id} className="px-4 py-2 font-sans text-xs">
              <span className="text-brand">{l.action}</span>
              {l.target && <span className="text-muted"> · {l.target}</span>}
              <span className="float-right text-muted">{fmtDate(l.createdAt)}</span>
            </li>
          ))}
          {d.auditLogs.length === 0 && <li className="px-4 py-4 text-center font-sans text-xs text-muted">No audit entries.</li>}
        </ul>
      </Panel>
    </>
  );
}

function ActionBtn({ children, onClick, disabled, danger }: {
  children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded border px-3 py-1.5 transition disabled:opacity-40 ${
        danger
          ? "border-brand/40 text-brand hover:enabled:bg-brand/10"
          : "border-border text-foreground hover:enabled:bg-surface-2"
      }`}
    >
      {children}
    </button>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-muted">{k}</dt>
      <dd className="text-right text-foreground">{v}</dd>
    </>
  );
}
