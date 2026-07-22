"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle, Panel, Badge, fmtDate } from "../ui";

type Msg = { role: "user" | "assistant"; content: string; at?: string };
type Ticket = {
  id: string; status: string; subject: string | null; category: string | null;
  severity: string; summary: string | null; messages: Msg[];
  email: string | null; name: string | null; plan: string | null;
  createdAt: string; updatedAt: string;
};
type Resp = { page: number; totalPages: number; total: number; openCount: number; tickets: Ticket[] };

const SEV_TONE: Record<string, string> = {
  high: "text-danger border-danger/40 bg-danger/10",
  normal: "text-warn border-warn/40 bg-warn/10",
  low: "text-muted border-border bg-surface-2",
};

export default function AdminSupport() {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [page, setPage] = useState(1);
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ status, page: String(page) });
    fetch(`/api/admin/support?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load."));
  }, [status, page]);

  useEffect(() => { setErr(""); load(); }, [load]);

  async function act(id: string, action: "resolve" | "reopen") {
    setBusy(id);
    try {
      const r = await fetch(`/api/admin/support/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (r.ok) load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <PageTitle title="Support" sub={d ? `${d.openCount} open · ${d.total} in view` : undefined} />

      <div className="mb-4 flex gap-1.5 font-sans text-xs">
        {(["open", "resolved", "all"] as const).map((s) => (
          <button
            key={s}
            onClick={() => { setStatus(s); setPage(1); }}
            className={`rounded-lg px-3 py-1.5 capitalize transition ${
              status === s ? "bg-brand/10 font-medium text-brand" : "text-muted hover:bg-surface-2"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {err && <p className="font-sans text-sm text-brand">{err}</p>}
      {!err && !d && <p className="font-sans text-sm text-muted">Loading…</p>}

      {d && d.tickets.length === 0 && (
        <Panel className="px-4 py-10 text-center font-sans text-sm text-muted">
          No {status === "all" ? "" : status} tickets.
        </Panel>
      )}

      <div className="space-y-2.5">
        {d?.tickets.map((t) => {
          const expanded = openId === t.id;
          return (
            <Panel key={t.id} className="overflow-hidden">
              <button
                onClick={() => setOpenId(expanded ? null : t.id)}
                className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left transition hover:bg-surface-2"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-block rounded border px-1.5 py-0.5 font-sans text-[11px] ${SEV_TONE[t.severity] ?? SEV_TONE.low}`}>
                      {t.severity}
                    </span>
                    {t.category && <Badge value={t.category} />}
                    {t.status === "resolved" && <Badge value="resolved" />}
                    <span className="truncate font-sans text-sm font-medium text-foreground">
                      {t.subject ?? "Support request"}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-2 font-sans text-xs text-muted">{t.summary ?? "—"}</p>
                  <p className="mt-1 font-sans text-[11px] text-muted">
                    {t.name ? `${t.name} · ` : ""}{t.email ?? "unknown"}{t.plan ? ` · ${t.plan}` : ""} · {fmtDate(t.updatedAt)}
                  </p>
                </div>
                <span className="shrink-0 font-sans text-xs text-muted">{expanded ? "▲" : "▼"}</span>
              </button>

              {expanded && (
                <div className="border-t border-border px-4 py-3">
                  <div className="max-h-80 space-y-2 overflow-y-auto">
                    {t.messages.map((m, i) => (
                      <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[80%] rounded-xl px-3 py-1.5 font-sans text-xs ${
                          m.role === "user" ? "bg-brand/10 text-foreground" : "bg-surface-2 text-muted"
                        }`}>
                          <span className="mb-0.5 block text-[10px] uppercase tracking-wide text-muted">
                            {m.role === "user" ? "User" : "Assistant"}
                          </span>
                          <span className="whitespace-pre-wrap">{m.content}</span>
                        </div>
                      </div>
                    ))}
                    {t.messages.length === 0 && <p className="font-sans text-xs text-muted">No messages.</p>}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {t.status === "open" ? (
                      <button
                        disabled={busy === t.id}
                        onClick={() => act(t.id, "resolve")}
                        className="rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 font-sans text-xs font-medium text-accent transition hover:bg-accent/20 disabled:opacity-50"
                      >
                        Mark resolved
                      </button>
                    ) : (
                      <button
                        disabled={busy === t.id}
                        onClick={() => act(t.id, "reopen")}
                        className="rounded-lg border border-border px-3 py-1.5 font-sans text-xs text-muted transition hover:bg-surface-2 disabled:opacity-50"
                      >
                        Reopen
                      </button>
                    )}
                    {t.email && (
                      <a
                        href={`mailto:${t.email}?subject=${encodeURIComponent("Re: " + (t.subject ?? "Your Grindly support request"))}`}
                        className="rounded-lg border border-border px-3 py-1.5 font-sans text-xs text-muted transition hover:bg-surface-2"
                      >
                        Email user
                      </a>
                    )}
                  </div>
                </div>
              )}
            </Panel>
          );
        })}
      </div>

      {d && d.totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 font-sans text-xs">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:enabled:bg-surface-2">← prev</button>
          <span className="text-muted">{page} / {d.totalPages}</span>
          <button disabled={page >= d.totalPages} onClick={() => setPage((p) => p + 1)}
            className="rounded border border-border px-3 py-1 disabled:opacity-40 hover:enabled:bg-surface-2">next →</button>
        </div>
      )}
    </>
  );
}
