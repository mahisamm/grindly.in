"use client";

import { useCallback, useEffect, useState } from "react";
import { PageTitle } from "../ui";

type Check = { id: string; label: string; ok: boolean; detail: string };
type HealthData = { checks: Check[]; allOk: boolean; checkedAt: string };

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
          className="rounded border border-[#262a33] px-4 py-2 font-mono text-sm text-[#e6e8eb] transition hover:enabled:bg-[#1d2027] disabled:opacity-50"
        >
          {running ? "Running…" : "Re-run diagnostics"}
        </button>
        {data && (
          <span className={`font-mono text-sm ${data.allOk ? "text-[#36d399]" : "text-[#ff4d4d]"}`}>
            {data.allOk ? "✓ All systems go" : "✗ Issues detected"}
          </span>
        )}
        {data && (
          <span className="font-mono text-xs text-[#5a606b]">
            checked {new Date(data.checkedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {err && <p className="mb-4 font-mono text-sm text-[#ff4d4d]">{err}</p>}

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
                  state === "ok" ? "border-[#36d399] bg-[#36d399]/10" :
                  state === "fail" ? "border-[#ff4d4d] bg-[#ff4d4d]/10" :
                  state === "scanning" ? "border-[#fbbd23] bg-[#fbbd23]/10" :
                  "border-[#262a33] bg-[#15171c]"
                }`}>
                  {state === "scanning" && (
                    <span className="absolute inset-0 rounded-full border-2 border-[#fbbd23] opacity-60 animate-ping" />
                  )}
                  <span className="text-base leading-none">
                    {state === "ok" ? "✓" : state === "fail" ? "✗" : state === "scanning" ? "…" : ICONS[check.id] ?? "○"}
                  </span>
                </div>

                {/* Label + detail */}
                <div className="min-w-0">
                  <div className={`font-mono text-sm font-semibold ${
                    state === "ok" ? "text-[#36d399]" :
                    state === "fail" ? "text-[#ff4d4d]" :
                    state === "scanning" ? "text-[#fbbd23]" :
                    "text-[#5a606b]"
                  }`}>
                    {ICONS[check.id] ?? ""} {realCheck?.label ?? check.label}
                  </div>
                  {state !== "pending" && (
                    <div className="mt-0.5 font-mono text-xs text-[#8b919c]">
                      {state === "scanning" ? "checking…" : (realCheck?.detail ?? "")}
                    </div>
                  )}
                </div>
              </div>

              {/* Connector line (not after last item) */}
              {idx < checks.length - 1 && (
                <div className={`ml-5 h-8 w-0.5 transition-colors duration-500 ${
                  state === "ok" ? "bg-[#36d399]/40" :
                  state === "fail" ? "bg-[#ff4d4d]/30" :
                  state === "scanning" ? "bg-[#fbbd23]/40" :
                  "bg-[#262a33]"
                }`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Summary box */}
      {data && !data.allOk && (
        <div className="mt-8 rounded-lg border border-[#ff4d4d]/30 bg-[#ff4d4d]/5 p-4">
          <div className="mb-2 font-mono text-sm font-bold text-[#ff4d4d]">Issues found</div>
          <ul className="space-y-1.5">
            {data.checks.filter((c) => !c.ok).map((c) => (
              <li key={c.id} className="font-mono text-xs">
                <span className="text-[#ff4d4d]">✗ {c.label}:</span>{" "}
                <span className="text-[#8b919c]">{c.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {data && data.allOk && (
        <div className="mt-8 rounded-lg border border-[#36d399]/30 bg-[#36d399]/5 p-4">
          <div className="font-mono text-sm text-[#36d399]">✓ Pipeline fully operational — agent is ready to run.</div>
        </div>
      )}
    </>
  );
}

function placeholderLabel(i: number): string {
  return ["Database connection", "Python runtime", "Playwright + Chromium", "Agent core files", "User profiles with resume", "Platform sessions", "Last agent run"][i] ?? "Check";
}
