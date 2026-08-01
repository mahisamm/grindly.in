"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PageTitle, Panel, Badge, TableWrap, FilterBar, fmtDate } from "../ui";

type App = {
  id: string; jobTitle: string; company: string; matchScore: number; status: string;
  failureReason: string | null; outcome: string | null; appliedAt: string | null; createdAt: string;
  url: string | null;
  user: { id: string; email: string };
  job: { source: string } | null;
};
type ListResp = { page: number; totalPages: number; total: number; applications: App[] };

type UserRow = {
  userId: string; email: string; name: string | null; plan: string; accessStatus: string;
  total: number; matched: number; applied: number; failed: number; skipped: number;
  lastActivity: string | null;
};
type GroupResp = { groupBy: "user"; users: UserRow[]; total: number };

const STATUSES = ["", "applied", "failed", "skipped", "matched", "needs_review", "submitting"];
const PLATFORMS = ["", "internshala", "atsboards", "websource"];

const inputCls =
  "w-full rounded border border-border bg-surface px-3 py-2 font-sans text-sm text-foreground outline-none placeholder:text-muted focus:border-brand sm:w-auto";

function AdminApplicationsInner() {
  const router = useRouter();
  const params = useSearchParams();
  // The selected user lives in the URL so "show me this user's applications" is
  // linkable — /admin/users/[id] deep-links straight into this view.
  const userId = params.get("userId") ?? "";
  const [mode, setMode] = useState<"list" | "byUser">(userId ? "list" : "byUser");

  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [platform, setPlatform] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ListResp | null>(null);
  const [groups, setGroups] = useState<GroupResp | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      setErr("");
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (mode === "byUser") {
        p.set("groupBy", "user");
        fetch(`/api/admin/applications?${p}`)
          .then((r) => (r.ok ? r.json() : Promise.reject(r)))
          .then(setGroups)
          .catch(() => setErr("Failed to load."));
        return;
      }
      p.set("page", String(page));
      if (status) p.set("status", status);
      if (platform) p.set("platform", platform);
      if (userId) p.set("userId", userId);
      fetch(`/api/admin/applications?${p}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .then(setData)
        .catch(() => setErr("Failed to load."));
    }, 200);
    return () => clearTimeout(t);
  }, [q, status, platform, page, mode, userId]);

  function selectUser(id: string) {
    router.push(`/admin/applications?userId=${encodeURIComponent(id)}`);
    setMode("list");
    setPage(1);
  }

  function clearUser() {
    router.push("/admin/applications");
    setPage(1);
  }

  const selectedEmail = userId
    ? data?.applications[0]?.user.email ?? groups?.users.find((u) => u.userId === userId)?.email ?? null
    : null;

  return (
    <>
      <PageTitle
        title="Applications"
        sub={
          mode === "byUser"
            ? groups ? `${groups.total} user(s) with applications` : undefined
            : data ? `${data.total} matching${userId ? " for this user" : " across all users"}` : undefined
        }
      />

      {/* Mode switch — "who got what" is a different question from "what happened
          lately", and answering the first by scrolling a global list was the gap. */}
      <div className="mb-4 inline-flex rounded-lg border border-border p-0.5 font-sans text-xs">
        {([["byUser", "By user"], ["list", "All applications"]] as const).map(([m, label]) => (
          <button
            key={m}
            onClick={() => { setMode(m); setPage(1); if (m === "byUser" && userId) clearUser(); }}
            className={`rounded-md px-3 py-1.5 transition ${
              mode === m ? "bg-brand/10 font-medium text-brand" : "text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {userId && mode === "list" && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-brand/40 bg-brand/5 px-3 py-2 font-sans text-xs">
          <span className="text-muted">Showing only</span>
          <span className="font-medium text-foreground">{selectedEmail ?? "this user"}</span>
          <Link href={`/admin/users/${userId}`} className="text-brand hover:underline">user detail →</Link>
          <button onClick={clearUser} className="ml-auto rounded border border-border px-2 py-1 text-muted hover:text-foreground">
            clear filter ✕
          </button>
        </div>
      )}

      <FilterBar>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setPage(1); }}
          placeholder={mode === "byUser" ? "search user email or name…" : "search job, company, email…"}
          className={`${inputCls} sm:max-w-xs`}
        />
        {mode === "list" && (
          <>
            <select
              value={status}
              aria-label="Filter by status"
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              className={inputCls}
            >
              {STATUSES.map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}
            </select>
            <select
              value={platform}
              aria-label="Filter by platform"
              onChange={(e) => { setPlatform(e.target.value); setPage(1); }}
              className={inputCls}
            >
              {PLATFORMS.map((p) => <option key={p} value={p}>{p || "all platforms"}</option>)}
            </select>
          </>
        )}
      </FilterBar>

      {err && <p className="font-sans text-sm text-brand">{err}</p>}

      {/* ── By user ── */}
      {mode === "byUser" && (
        <>
          {!err && !groups && <p className="font-sans text-sm text-muted">Loading…</p>}
          {groups && (
            <Panel>
              <TableWrap min="min-w-[640px]">
                <table className="w-full text-left font-sans text-xs">
                  <thead className="text-muted">
                    <tr className="border-b border-border">
                      <th className="px-4 py-2 font-medium">User</th>
                      <th className="px-4 py-2 font-medium text-right">Total</th>
                      <th className="px-4 py-2 font-medium text-right">Matched</th>
                      <th className="px-4 py-2 font-medium text-right">Applied</th>
                      <th className="px-4 py-2 font-medium text-right">Failed</th>
                      <th className="px-4 py-2 font-medium">Last activity</th>
                      <th className="px-4 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {groups.users.map((u) => (
                      <tr key={u.userId} className="border-b border-surface-2 hover:bg-surface-2">
                        <td className="px-4 py-2">
                          <Link href={`/admin/users/${u.userId}`} className="text-brand hover:underline">
                            {u.email}
                          </Link>
                          <div className="text-muted">
                            {u.name ? `${u.name} · ` : ""}{u.plan}
                            {u.accessStatus !== "approved" && <span className="ml-1"><Badge value={u.accessStatus} /></span>}
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-foreground">{u.total}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-muted">{u.matched}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-accent">{u.applied}</td>
                        <td className={`px-4 py-2 text-right tabular-nums ${u.failed > 0 ? "text-danger" : "text-muted"}`}>{u.failed}</td>
                        <td className="px-4 py-2 text-muted">{fmtDate(u.lastActivity)}</td>
                        <td className="px-4 py-2">
                          <button onClick={() => selectUser(u.userId)} className="rounded border border-border px-2 py-1 text-muted hover:text-foreground">
                            view {u.total} →
                          </button>
                        </td>
                      </tr>
                    ))}
                    {groups.users.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-muted">No users match.</td></tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            </Panel>
          )}
        </>
      )}

      {/* ── Flat list ── */}
      {mode === "list" && (
        <>
          {!err && !data && <p className="font-sans text-sm text-muted">Loading…</p>}
          {data && (
            <Panel>
              <TableWrap min="min-w-[860px]">
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
                    {data.applications.map((a) => (
                      <tr key={a.id} className="border-b border-surface-2 hover:bg-surface-2">
                        <td className="px-4 py-2">
                          <Link href={`/admin/applications?userId=${a.user.id}`} className="text-brand hover:underline">
                            {a.user.email}
                          </Link>
                        </td>
                        <td className="max-w-[220px] px-4 py-2">
                          <div className="truncate" title={`${a.jobTitle} · ${a.company}`}>
                            {a.url ? (
                              <a href={a.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                                {a.jobTitle}
                              </a>
                            ) : a.jobTitle}
                            <span className="text-muted"> · {a.company}</span>
                          </div>
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
                    {data.applications.length === 0 && (
                      <tr><td colSpan={7} className="px-4 py-6 text-center text-muted">No applications match.</td></tr>
                    )}
                  </tbody>
                </table>
              </TableWrap>
            </Panel>
          )}

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
      )}
    </>
  );
}

// useSearchParams needs a Suspense boundary in the app router.
export default function AdminApplications() {
  return (
    <Suspense fallback={<p className="font-sans text-sm text-muted">Loading…</p>}>
      <AdminApplicationsInner />
    </Suspense>
  );
}
