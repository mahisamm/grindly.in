"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle, Panel, StatCard, fmtDate } from "../ui";

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

  if (err) return <p className="font-mono text-sm text-[#ff4d4d]">{err}</p>;
  if (!d) return <p className="font-mono text-sm text-[#8b919c]">Loading…</p>;

  return (
    <>
      <PageTitle title="Access control" sub="Approve who can use Grindly. New signups wait here until you let them in." />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 mb-6">
        <StatCard label="Awaiting approval" value={d.pending.length} tone={d.pending.length > 0 ? "warn" : "default"} />
        <StatCard label="Requested access" value={d.pending.filter((p) => p.requested).length} hint="tapped the button" />
        <StatCard label="Pre-allowlisted" value={d.allowlist.length} hint="emails cleared ahead of signup" />
      </div>

      {msg && (
        <div className={`mb-4 rounded border px-3 py-2 font-mono text-xs ${msg.ok ? "border-[#36d399]/40 bg-[#36d399]/10 text-[#36d399]" : "border-[#ff4d4d]/40 bg-[#ff4d4d]/10 text-[#ff4d4d]"}`}>
          {msg.text}
        </div>
      )}

      {/* Grant by email */}
      <Panel className="mb-6 p-5">
        <div className="mb-3 font-mono text-sm font-bold">Grant access by email</div>
        <form onSubmit={grantEmail} className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@email.com"
            className="min-w-[220px] flex-1 rounded border border-[#262a33] bg-[#0d1117] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none focus:border-[#9db4ff]"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="note (optional)"
            className="min-w-[160px] rounded border border-[#262a33] bg-[#0d1117] px-3 py-2 font-mono text-sm text-[#e6e8eb] outline-none focus:border-[#9db4ff]"
          />
          <button
            type="submit"
            disabled={busy === "allow"}
            className="rounded bg-[#36d399] px-4 py-2 font-mono text-sm font-bold text-black transition hover:opacity-90 disabled:opacity-50"
          >
            {busy === "allow" ? "…" : "Grant access"}
          </button>
        </form>
        <p className="mt-2 font-mono text-[11px] text-[#5a606b]">
          Works before they sign up. If the email already has an account, it&apos;s approved immediately.
        </p>
      </Panel>

      {/* Pending queue */}
      <Panel className="mb-6">
        <div className="border-b border-[#262a33] px-4 py-3 font-mono text-sm font-bold">
          Pending requests ({d.pending.length})
        </div>
        {d.pending.length === 0 ? (
          <p className="px-4 py-6 font-mono text-sm text-[#8b919c]">Nobody waiting. All clear.</p>
        ) : (
          <table className="w-full text-left font-mono text-xs">
            <thead className="text-[#5a606b]">
              <tr className="border-b border-[#262a33]">
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Signed up</th>
                <th className="px-4 py-2 font-medium">Requested</th>
                <th className="px-4 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {d.pending.map((p) => (
                <tr key={p.id} className="border-b border-[#1d2027] hover:bg-[#1a1d23]">
                  <td className="px-4 py-2">
                    <div className="text-[#e6e8eb]">{p.email}</div>
                    {p.name && <div className="text-[#5a606b]">{p.name}</div>}
                  </td>
                  <td className="px-4 py-2 text-[#5a606b]">{fmtDate(p.createdAt)}</td>
                  <td className="px-4 py-2">
                    {p.requested ? (
                      <span className="rounded border border-[#fbbd23]/40 bg-[#fbbd23]/10 px-1.5 py-0.5 text-[#fbbd23]">
                        {fmtDate(p.requestedAt)}
                      </span>
                    ) : (
                      <span className="text-[#5a606b]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => act({ action: "approve", userId: p.id }, `ap-${p.id}`)}
                        disabled={busy === `ap-${p.id}`}
                        className="rounded bg-[#36d399] px-2.5 py-1 font-bold text-black transition hover:opacity-90 disabled:opacity-50"
                      >
                        {busy === `ap-${p.id}` ? "…" : "Approve"}
                      </button>
                      <button
                        onClick={() => act({ action: "deny", userId: p.id }, `dn-${p.id}`)}
                        disabled={busy === `dn-${p.id}`}
                        className="rounded border border-[#ff4d4d]/40 px-2.5 py-1 text-[#ff4d4d] transition hover:bg-[#ff4d4d]/10 disabled:opacity-50"
                      >
                        Deny
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Allowlist */}
        <Panel>
          <div className="border-b border-[#262a33] px-4 py-3 font-mono text-sm font-bold">
            Allowlist ({d.allowlist.length})
          </div>
          {d.allowlist.length === 0 ? (
            <p className="px-4 py-6 font-mono text-sm text-[#8b919c]">No pre-approved emails.</p>
          ) : (
            <ul className="divide-y divide-[#1d2027]">
              {d.allowlist.map((a) => (
                <li key={a.email} className="flex items-center gap-2 px-4 py-2 font-mono text-xs">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[#e6e8eb]">{a.email}</div>
                    {a.note && <div className="truncate text-[#5a606b]">{a.note}</div>}
                  </div>
                  <button
                    onClick={() => act({ action: "unallow", email: a.email }, `rm-${a.email}`)}
                    disabled={busy === `rm-${a.email}`}
                    className="text-[#8b919c] transition hover:text-[#ff4d4d] disabled:opacity-50"
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
          <div className="border-b border-[#262a33] px-4 py-3 font-mono text-sm font-bold">Recently granted</div>
          {d.recentlyGranted.length === 0 ? (
            <p className="px-4 py-6 font-mono text-sm text-[#8b919c]">No approvals yet.</p>
          ) : (
            <ul className="divide-y divide-[#1d2027]">
              {d.recentlyGranted.map((u) => (
                <li key={u.id} className="flex items-center justify-between gap-2 px-4 py-2 font-mono text-xs">
                  <span className="truncate text-[#e6e8eb]">{u.email}</span>
                  <span className="shrink-0 text-[#5a606b]">{fmtDate(u.accessGrantedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
