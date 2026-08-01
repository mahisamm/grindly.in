"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle } from "../ui";

type Check = { id: string; label: string; ok: boolean; detail: string };
type HealthData = {
  queue?: {
    queueDepth: number;
    runningCount: number;
    staleCount: number;
    recentFailed: { userId: string; error: string | null; updatedAt: string }[];
  };
  funnel?: FunnelDay[];
  lastHarvest?: { target: string | null; detail: string | null; createdAt: string } | null;
  capacity?: {
    live: number; employerSide: number; board: number; k: number;
    handsOffUsers: number; connectedUsers: number;
  } | null;
  checks: Check[]; allOk: boolean; checkedAt: string };

type FunnelDay = {
  day: string;
  scored: number;
  matched: number;
  sent: number;
  failed: number;
  needsReview: number;
  sendable: number;
};

const ICONS: Record<string, string> = {
  db: "🗄️",
  python: "🐍",
  playwright: "🎭",
  agent_files: "📂",
  profiles: "👤",
  sessions: "🔌",
  last_run: "⏱️",
};

export default function AgentHealthPage() {
  const [data, setData] = useState<HealthData | null>(null);
  const [running, setRunning] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [err, setErr] = useState("");

  const runDiagnostics = useCallback(async () => {
    setRunning(true);
    setActiveIdx(-1);
    setData(null);
    setErr("");

    // Animate steps appearing one by one before real data arrives
    const animate = async () => {
      for (let i = 0; i < 7; i++) {
        setActiveIdx(i);
        await new Promise((r) => setTimeout(r, 350));
      }
    };

    const [result] = await Promise.all([
      fetch("/api/admin/agent-health")
        .then((r) => (r.ok ? r.json() : Promise.reject(r)))
        .catch(() => { setErr("Diagnostics failed."); return null; }),
      animate(),
    ]);

    setData(result);
    setActiveIdx(-1);
    setRunning(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- run diagnostics once on mount (data load)
  useEffect(() => { runDiagnostics(); }, [runDiagnostics]);

  // Decide node state for each check
  function nodeState(idx: number, check?: Check): "pending" | "scanning" | "ok" | "fail" {
    if (!running && !data) return "pending";
    if (running && idx > activeIdx) return "pending";
    if (running && idx === activeIdx) return "scanning";
    if (running && idx < activeIdx) return "scanning"; // still "checking" until data arrives
    if (data) return check?.ok ? "ok" : "fail";
    return "pending";
  }

  const checks = data?.checks ?? Array.from({ length: 7 }, (_, i) => ({ id: String(i), label: placeholderLabel(i), ok: false, detail: "" }));

  return (
    <>
      <PageTitle
        title="Agent diagnostics"
        sub="Step-by-step pipeline health check — like WiFi troubleshooting"
      />

      <div className="flex items-center gap-4 mb-8">
        <button
          onClick={runDiagnostics}
          disabled={running}
          className="rounded border border-border px-4 py-2 font-sans text-sm text-foreground transition hover:enabled:bg-surface-2 disabled:opacity-50"
        >
          {running ? "Running…" : "Re-run diagnostics"}
        </button>
        {data && (
          <span className={`font-sans text-sm ${data.allOk ? "text-accent" : "text-brand"}`}>
            {data.allOk ? "✓ All systems go" : "✗ Issues detected"}
          </span>
        )}
        {data && (
          <span className="font-sans text-xs text-muted">
            checked {new Date(data.checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {err && <p className="mb-4 font-sans text-sm text-brand">{err}</p>}

      {/* Flowchart */}
      <div className="flex flex-col items-start gap-0">
        {checks.map((check, idx) => {
          const state = nodeState(idx, data?.checks[idx]);
          const realCheck = data?.checks[idx];
          return (
            <div key={check.id} className="flex flex-col items-start">
              {/* Node */}
              <div className="flex items-center gap-4">
                {/* Status circle */}
                <div className={`relative flex size-10 shrink-0 items-center justify-center rounded-full border-2 transition-all duration-300 ${
                  state === "ok" ? "border-accent bg-accent/10" :
                  state === "fail" ? "border-brand bg-brand/10" :
                  state === "scanning" ? "border-warn bg-warn/10" :
                  "border-border bg-surface"
                }`}>
                  {state === "scanning" && (
                    <span className="absolute inset-0 rounded-full border-2 border-warn opacity-60 animate-ping" />
                  )}
                  <span className="text-base leading-none">
                    {state === "ok" ? "✓" : state === "fail" ? "✗" : state === "scanning" ? "…" : ICONS[check.id] ?? "○"}
                  </span>
                </div>

                {/* Label + detail */}
                <div className="min-w-0">
                  <div className={`font-sans text-sm font-semibold ${
                    state === "ok" ? "text-accent" :
                    state === "fail" ? "text-brand" :
                    state === "scanning" ? "text-warn" :
                    "text-muted"
                  }`}>
                    {ICONS[check.id] ?? ""} {realCheck?.label ?? check.label}
                  </div>
                  {state !== "pending" && (
                    <div className="mt-0.5 font-sans text-xs text-muted">
                      {state === "scanning" ? "checking…" : (realCheck?.detail ?? "")}
                    </div>
                  )}
                </div>
              </div>

              {/* Connector line (not after last item) */}
              {idx < checks.length - 1 && (
                <div className={`ml-5 h-8 w-0.5 transition-colors duration-500 ${
                  state === "ok" ? "bg-accent/40" :
                  state === "fail" ? "bg-brand/30" :
                  state === "scanning" ? "bg-warn/40" :
                  "bg-border"
                }`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Summary box */}
      {data && !data.allOk && (
        <div className="mt-8 rounded-lg border border-brand/30 bg-brand/5 p-4">
          <div className="mb-2 font-sans text-sm font-bold text-brand">Issues found</div>
          <ul className="space-y-1.5">
            {data.checks.filter((c) => !c.ok).map((c) => (
              <li key={c.id} className="font-sans text-xs">
                <span className="text-brand">✗ {c.label}:</span>{" "}
                <span className="text-muted">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data?.queue && (
      <div className="mt-6 rounded-lg border border-border/40 bg-surface-2/30 p-4">
        <div className="mb-2 font-sans text-sm font-bold text-muted">Worker Queue</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded bg-surface-2/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Queued</div>
            <div className={`text-2xl font-bold font-sans ${data.queue.queueDepth > 10 ? "text-warn" : "text-foreground"}`}>{data.queue.queueDepth}</div>
          </div>
          <div className="rounded bg-surface-2/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Running</div>
            <div className="text-2xl font-bold font-sans text-accent">{data.queue.runningCount}</div>
          </div>
          <div className="rounded bg-surface-2/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Stale (&gt;30m)</div>
            <div className={`text-2xl font-bold font-sans ${data.queue.staleCount > 0 ? "text-brand" : "text-foreground"}`}>{data.queue.staleCount}</div>
          </div>
          <div className="rounded bg-surface-2/60 px-3 py-2">
            <div className="text-[11px] uppercase tracking-wide text-muted">Recent failed</div>
            <div className={`text-2xl font-bold font-sans ${data.queue.recentFailed.length > 0 ? "text-brand" : "text-foreground"}`}>{data.queue.recentFailed.length}</div>
          </div>
        </div>
        {data.queue.recentFailed.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="text-[11px] uppercase tracking-wide text-muted">Recent failures</div>
            {data.queue.recentFailed.map((r, i) => (
              <div key={i} className="font-sans text-xs text-muted">
                <span className="text-brand">{r.userId.slice(0, 8)}</span>{" "}{r.error ?? "unknown"}{" "}<span className="opacity-50">{new Date(r.updatedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )}

    {/* How many users the pool can serve. On this page because the failure is
        silent: an agent serving 52 users out of a 300-listing pool looks
        identical, from every other panel here, to one serving 500 — right up to
        the morning the 53rd signs up and starts getting two applications a day
        instead of five. Nothing else here would say so. */}
    {data?.capacity && (
      <div className="mt-6 rounded-lg border border-border/40 bg-surface-2/30 p-4">
        <div className="mb-1 font-sans text-sm font-bold text-muted">
          What the pool can serve
        </div>
        <div className="mb-3 font-sans text-[11px] text-muted">
          {data.capacity.live} live listings — {data.capacity.employerSide} with an
          employer-side route, {data.capacity.board} on Internshala. Each goes to at
          most {data.capacity.k} users.
        </div>
        <div className="flex flex-wrap gap-6 font-sans">
          <div>
            <div className="text-2xl font-bold text-foreground">
              {data.capacity.handsOffUsers}
            </div>
            <div className="text-[11px] text-muted">
              users at 5/day, <strong>connecting nothing</strong>
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">
              {data.capacity.connectedUsers}
            </div>
            <div className="text-[11px] text-muted">
              users at 5/day, if they connect Internshala
            </div>
          </div>
          <div>
            <div className="text-2xl font-bold text-foreground">
              {Math.floor(data.capacity.handsOffUsers / 3)}
            </div>
            <div className="text-[11px] text-muted">
              pro users at 15/day, connecting nothing
            </div>
          </div>
        </div>
        {data.capacity.employerSide === 0 && data.capacity.live > 0 && (
          <p className="mt-3 font-sans text-[11px] text-danger">
            No listing has a resolved employer-side route, so a user who connects
            nothing can be served zero applications — however large the pool looks.
            The daily route pass fills this in.
          </p>
        )}
      </div>
    )}

    {data?.funnel && data.funnel.length > 0 && (
      <div className="mt-6 rounded-lg border border-border/40 bg-surface-2/30 p-4">
        <div className="mb-1 font-sans text-sm font-bold text-muted">
          Pipeline, last 7 days
        </div>
        {/* Each stage feeds the next, so whichever column collapses first is
            where a slow day died. "Sendable" excludes tier C deliberately —
            counting boards that hold the user's account as pipeline is how
            "43 in queue" once meant "43 things the agent cannot send". */}
        <div className="mb-3 font-sans text-[11px] text-muted">
          Scored → matched → sendable (tier A/B only) → sent.
          {data.lastHarvest && (
            <> Board index: {data.lastHarvest.detail ?? "—"} (last harvest{" "}
              {new Date(data.lastHarvest.createdAt).toLocaleDateString()},
              learned {data.lastHarvest.target ?? "—"}).</>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[34rem] font-sans text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="pb-1 pr-3 font-normal">Day</th>
                <th className="pb-1 pr-3 font-normal">Scored</th>
                <th className="pb-1 pr-3 font-normal">Matched</th>
                <th className="pb-1 pr-3 font-normal">Sendable</th>
                <th className="pb-1 pr-3 font-normal">Sent</th>
                <th className="pb-1 pr-3 font-normal">Needs you</th>
                <th className="pb-1 font-normal">Failed</th>
              </tr>
            </thead>
            <tbody>
              {data.funnel.map((d) => (
                <tr key={d.day} className="border-t border-border/30">
                  <td className="py-1 pr-3 text-muted">{d.day.slice(5)}</td>
                  <td className="py-1 pr-3">{d.scored}</td>
                  <td className="py-1 pr-3">{d.matched}</td>
                  <td className="py-1 pr-3">{d.sendable}</td>
                  <td className={`py-1 pr-3 font-bold ${d.sent > 0 ? "text-accent" : "text-muted"}`}>
                    {d.sent}
                  </td>
                  <td className="py-1 pr-3">{d.needsReview}</td>
                  <td className={`py-1 ${d.failed > 0 ? "text-brand" : ""}`}>{d.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    )}

    {data && data.allOk && (
        <div className="mt-8 rounded-lg border border-accent/30 bg-accent/5 p-4">
          <div className="font-sans text-sm text-accent">✓ Pipeline fully operational — agent is ready to run.</div>
        </div>
      )}
    </>
  );
}

function placeholderLabel(i: number): string {
  return ["Database connection", "Python runtime", "Playwright + Chromium", "Agent core files", "User profiles with resume", "Platform sessions", "Last agent run"][i] ?? "Check";
}
