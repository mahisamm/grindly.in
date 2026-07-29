"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle, Panel, Badge, fmtDate } from "../ui";

type ErrorRow = {
  id: string;
  fingerprint: string;
  source: string;
  kind: string;
  message: string;
  stack: string | null;
  context: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
};

type Resp = { total: number; open: number; errors: ErrorRow[] };

export default function AdminErrors() {
  const [d, setD] = useState<Resp | null>(null);
  const [err, setErr] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (showResolved) params.set("resolved", "1");
    fetch(`/api/admin/errors?${params}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then(setD)
      .catch(() => setErr("Failed to load."));
  }, [showResolved]);

  useEffect(() => { load(); }, [load]);

  async function acknowledge(fingerprint: string, resolved: boolean) {
    await fetch("/api/admin/errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fingerprint, resolved }),
    }).catch(() => null);
    load();
  }

  return (
    <>
      <PageTitle
        title="Crashes"
        sub={d ? `${d.open} open · grouped by fault, not by occurrence` : undefined}
      />

      <p className="mb-4 max-w-2xl font-sans text-sm text-muted">
        Every failure the worker, the web app and the browser record. Repeats of the
        same fault bump a count rather than adding a row — one exception inside a
        retry loop is one line here, not four hundred. Acknowledging keeps the row;
        if the fault happens again it reopens itself.
      </p>

      <label className="mb-4 flex cursor-pointer items-center gap-2 font-sans text-sm text-muted">
        <input
          type="checkbox"
          checked={showResolved}
          onChange={(e) => setShowResolved(e.target.checked)}
        />
        Include acknowledged
      </label>

      {err && <p className="font-sans text-sm text-brand">{err}</p>}
      {!err && !d && <p className="font-sans text-sm text-muted">Loading…</p>}

      {d && d.errors.length === 0 && (
        <Panel>
          <p className="font-sans text-sm text-muted">
            Nothing recorded. Either the last deploy is behaving, or nothing has run
            since it — check the agent health page before believing the first one.
          </p>
        </Panel>
      )}

      <div className="space-y-3">
        {d?.errors.map((e) => (
          <Panel key={e.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge value={e.source} />
                  <span className="font-mono text-sm text-foreground">{e.kind}</span>
                  {e.count > 1 && (
                    <span className="font-sans text-xs text-muted">×{e.count}</span>
                  )}
                  {e.resolvedAt && (
                    <Badge value="acknowledged" />
                  )}
                </div>
                <p className="mt-1.5 break-words font-sans text-sm text-foreground">
                  {e.message}
                </p>
                <p className="mt-1 font-sans text-xs text-muted">
                  first {fmtDate(e.firstSeenAt)} · last {fmtDate(e.lastSeenAt)}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {(e.stack || e.context) && (
                  <button
                    onClick={() => setOpen(open === e.id ? null : e.id)}
                    className="rounded border border-border px-3 py-1.5 font-sans text-xs text-muted transition hover:text-foreground"
                  >
                    {open === e.id ? "Hide" : "Trace"}
                  </button>
                )}
                <button
                  onClick={() => acknowledge(e.fingerprint, !e.resolvedAt)}
                  className="rounded border border-border px-3 py-1.5 font-sans text-xs text-muted transition hover:text-foreground"
                >
                  {e.resolvedAt ? "Reopen" : "Acknowledge"}
                </button>
              </div>
            </div>

            {open === e.id && (
              <div className="mt-3 space-y-2">
                {e.context && (
                  <pre className="overflow-x-auto rounded bg-surface-2 p-3 font-mono text-xs text-muted">
                    {e.context}
                  </pre>
                )}
                {e.stack && (
                  <pre className="max-h-80 overflow-auto rounded bg-surface-2 p-3 font-mono text-xs text-muted">
                    {e.stack}
                  </pre>
                )}
              </div>
            )}
          </Panel>
        ))}
      </div>
    </>
  );
}
