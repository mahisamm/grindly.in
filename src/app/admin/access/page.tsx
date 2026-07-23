"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle, Panel, StatCard, fmtDate, TableWrap } from "../ui";

type Pending = { id: string; email: string; name: string | null; createdAt: string; requestedAt: string | null; requested: boolean };
type Allow = { email: string; note: string | null; createdAt: string };
type Granted = { id: string; email: string; name: string | null; accessGrantedAt: string };
type Data = { pending: Pending[]; allowlist: Allow[]; recentlyGranted: Granted[] };

export default function AccessPage() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    fetch("/api/admin/access")
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load."));
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  async function act(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setMsg(null);
    try {
      const r = await fetch("/api/admin/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMsg({ ok: false, text: j.error || "Action failed." });
      } else {
        load();
      }
      return { ok: r.ok, j };
    } finally {
      setBusy(null);
    }
  }

  async function grantEmail(e: React.FormEvent) {
    e.preventDefault();
    const clean = email.trim().toLowerCase();
    if (!clean) return;
    const res = await act({ action: "allow", email: clean, note: note.trim() || undefined }, "allow");
    if (res.ok) {
      setMsg({ ok: true, text: res.j.grantedExisting ? `${clean} was already signed up — access granted now.` : `${clean} allowlisted — access is granted the moment they sign in.` });
      setEmail("");
      setNote("");
    }
  }

  if (err) return <p className="font-sans text-sm text-brand">{err}</p>;
  if (!d) return <p className="font-sans text-sm text-muted">Loading…</p>;

  return (
    <>
      <PageTitle title="Access control" sub="Approve who can use Grindly. New signups wait here until you let them in." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 mb-6">
        <StatCard label="Awaiting approval" value={d.pending.length} tone={d.pending.length > 0 ? "warn" : "default"} />
        <StatCard label="Requested access" value={d.pending.filter((p) => p.requested).length} hint="tapped the button" />
        <StatCard label="Pre-allowlisted" value={d.allowlist.length} hint="emails cleared ahead of signup" />
      </div>

      {msg && (
        <div className={`mb-4 rounded border px-3 py-2 font-sans text-xs ${msg.ok ? "border-accent/40 bg-accent/10 text-accent" : "border-brand/40 bg-brand/10 text-brand"}`}>
          {msg.text}
        </div>
      )}

      {/* Grant by email */}
      <Panel className="mb-6 p-5">
        <div className="mb-3 font-sans text-sm font-bold">Grant access by email</div>
        <form onSubmit={grantEmail} className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@email.com"
            className="min-w-[220px] flex-1 rounded border border-border bg-surface-2 px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-brand"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (optional)"
            className="min-w-[160px] rounded border border-border bg-surface-2 px-3 py-2 font-sans text-sm text-foreground outline-none focus:border-brand"
          />
          <button
            type="submit"
            disabled={busy === "allow"}
            className="rounded bg-accent px-4 py-2 font-sans text-sm font-bold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {busy === "allow" ? "…" : "Grant access"}
          </button>
        </form>
        <p className="mt-2 font-sans text-[11px] text-muted">
          Works before they sign up. If the email already has an account, it&apos;s approved immediately.
        </p>
      </Panel>

      {/* Pending queue */}
      <Panel className="mb-6">
        <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">
          Pending requests ({d.pending.length})
        </div>
        {d.pending.length === 0 ? (
          <p className="px-4 py-6 font-sans text-sm text-muted">Nobody waiting. All clear.</p>
        ) : (
          <TableWrap min="min-w-[640px]">
            <table className="w-full text-left font-sans text-xs">
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">Email</th>
                  <th className="px-4 py-2 font-medium">Signed up</th>
                  <th className="px-4 py-2 font-medium">Requested</th>
                  <th className="px-4 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {d.pending.map((p) => (
                  <tr key={p.id} className="border-b border-surface-2 hover:bg-surface-2">
                    <td className="px-4 py-2">
                      <div className="text-foreground">{p.email}</div>
                      {p.name && <div className="text-muted">{p.name}</div>}
                    </td>
                    <td className="px-4 py-2 text-muted">{fmtDate(p.createdAt)}</td>
                    <td className="px-4 py-2">
                      {p.requested ? (
                        <span className="rounded border border-warn/40 bg-warn/10 px-1.5 py-0.5 text-warn">
                          {fmtDate(p.requestedAt)}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => act({ action: "approve", userId: p.id }, `ap-${p.id}`)}
                          disabled={busy === `ap-${p.id}`}
                          className="rounded bg-accent px-2.5 py-1 font-bold text-white transition hover:opacity-90 disabled:opacity-50"
                        >
                          {busy === `ap-${p.id}` ? "…" : "Approve"}
                        </button>
                        <button
                          onClick={() => act({ action: "deny", userId: p.id }, `dn-${p.id}`)}
                          disabled={busy === `dn-${p.id}`}
                          className="rounded border border-brand/40 px-2.5 py-1 text-brand transition hover:bg-brand/10 disabled:opacity-50"
                        >
                          Deny
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Allowlist */}
        <Panel>
          <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">
            Allowlist ({d.allowlist.length})
          </div>
          {d.allowlist.length === 0 ? (
            <p className="px-4 py-6 font-sans text-sm text-muted">No pre-approved emails.</p>
          ) : (
            <ul className="divide-y divide-surface-2">
              {d.allowlist.map((a) => (
                <li key={a.email} className="flex items-center gap-2 px-4 py-2 font-sans text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-foreground">{a.email}</div>
                    {a.note && <div className="truncate text-muted">{a.note}</div>}
                  </div>
                  <button
                    onClick={() => act({ action: "unallow", email: a.email }, `rm-${a.email}`)}
                    disabled={busy === `rm-${a.email}`}
                    className="text-muted transition hover:text-brand disabled:opacity-50"
                    title="Remove from allowlist"
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {/* Recently granted */}
        <Panel>
          <div className="border-b border-border px-4 py-3 font-sans text-sm font-bold">Recently granted</div>
          {d.recentlyGranted.length === 0 ? (
            <p className="px-4 py-6 font-sans text-sm text-muted">No approvals yet.</p>
          ) : (
            <ul className="divide-y divide-surface-2">
              {d.recentlyGranted.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 px-4 py-2 font-sans text-xs">
                  <span className="truncate text-foreground">{u.email}</span>
                  <span className="shrink-0 text-muted">{fmtDate(u.accessGrantedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
