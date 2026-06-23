"use client";

import { ReactNode } from "react";

export function PageTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="mb-6">
      <h1 className="font-mono text-xl font-bold tracking-tight text-[#e6e8eb]">{title}</h1>
      {sub && <p className="mt-1 font-mono text-xs text-[#8b919c]">{sub}</p>}
    </div>
  );
}

export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[#262a33] bg-[#15171c] ${className}`}>{children}</div>
  );
}

export function StatCard({ label, value, hint, tone = "default" }: {
  label: string; value: ReactNode; hint?: string; tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneColor = {
    default: "text-[#e6e8eb]", good: "text-[#36d399]", warn: "text-[#fbbd23]", bad: "text-[#ff4d4d]",
  }[tone];
  return (
    <Panel className="px-4 py-3">
      <div className="font-mono text-[11px] uppercase tracking-wide text-[#8b919c]">{label}</div>
      <div className={`mt-1 font-mono text-2xl font-bold tabular-nums ${toneColor}`}>{value}</div>
      {hint && <div className="mt-0.5 font-mono text-[11px] text-[#8b919c]">{hint}</div>}
    </Panel>
  );
}

const STATUS_TONE: Record<string, string> = {
  active: "text-[#36d399] border-[#36d399]/40 bg-[#36d399]/10",
  connected: "text-[#36d399] border-[#36d399]/40 bg-[#36d399]/10",
  applied: "text-[#36d399] border-[#36d399]/40 bg-[#36d399]/10",
  paused: "text-[#fbbd23] border-[#fbbd23]/40 bg-[#fbbd23]/10",
  needs_login: "text-[#fbbd23] border-[#fbbd23]/40 bg-[#fbbd23]/10",
  connecting: "text-[#fbbd23] border-[#fbbd23]/40 bg-[#fbbd23]/10",
  failed: "text-[#ff4d4d] border-[#ff4d4d]/40 bg-[#ff4d4d]/10",
  admin: "text-[#ff4d4d] border-[#ff4d4d]/40 bg-[#ff4d4d]/10",
};

export function Badge({ value }: { value: string }) {
  const tone = STATUS_TONE[value] ?? "text-[#8b919c] border-[#262a33] bg-[#1d2027]";
  return (
    <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] ${tone}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

// Dependency-free inline SVG bar chart for the applied-per-day trend.
export function BarTrend({ data }: { data: { date: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const W = 560, H = 120, pad = 16;
  const bw = (W - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="applied per day">
      {data.map((d, i) => {
        const h = (d.count / max) * (H - pad * 2);
        const x = pad + i * bw;
        return (
          <g key={d.date}>
            <rect
              x={x + 1} y={H - pad - h} width={bw - 3} height={h}
              rx={2} fill="#ff4d4d" opacity={0.85}
            />
            {d.count > 0 && (
              <text x={x + bw / 2} y={H - pad - h - 3} textAnchor="middle" fontSize="9" fill="#8b919c" fontFamily="monospace">
                {d.count}
              </text>
            )}
            {i % 2 === 0 && (
              <text x={x + bw / 2} y={H - 4} textAnchor="middle" fontSize="8" fill="#5a606b" fontFamily="monospace">
                {d.date.slice(5)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

export function fmtDate(s: string | Date | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
