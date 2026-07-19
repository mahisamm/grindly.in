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

// 7-day activity table — cleaner than a bar chart, shows applied + failed per day.
export function WeekTable({ data }: { data: { date: string; count: number }[] }) {
  // Only show last 7 days
  const rows = data.slice(-7);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <table className="w-full font-mono text-xs">
      <thead>
        <tr className="border-b border-[#262a33] text-[#5a606b]">
          <th className="py-2 text-left font-medium">Date</th>
          <th className="py-2 text-right font-medium">Applied</th>
          <th className="py-2 text-right font-medium pr-2">Activity</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => {
          const isToday = d.date === today;
          const pct = data.length ? Math.round((d.count / Math.max(1, ...data.map(x => x.count))) * 100) : 0;
          return (
            <tr key={d.date} className={`border-b border-[#1d2027] ${isToday ? "bg-[#1a1d23]" : ""}`}>
              <td className={`py-2 ${isToday ? "text-[#e6e8eb] font-bold" : "text-[#8b919c]"}`}>
                {d.date.slice(5)}{isToday ? " (today)" : ""}
              </td>
              <td className={`py-2 text-right tabular-nums ${d.count > 0 ? "text-[#36d399]" : "text-[#5a606b]"}`}>
                {d.count > 0 ? `+${d.count}` : "—"}
              </td>
              <td className="py-2 pr-2">
                <div className="flex justify-end">
                  <div className="h-2 w-32 rounded-full bg-[#1d2027] overflow-hidden">
                    <div
                      className="h-full rounded-full bg-[#36d399] transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              </td>
            </tr>
          );
        })}
        {rows.every(r => r.count === 0) && (
          <tr>
            <td colSpan={3} className="py-4 text-center text-[#5a606b]">No applications yet in last 7 days.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export function fmtDate(s: string | Date | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// ── Charts ──────────────────────────────────────────────────────────────────
// All hand-rolled inline SVG: no chart lib, no external request — the app CSP is
// self-only, so a dependency would be a footgun. Colours match the admin palette.

type Series = { name: string; color: string; values: number[] };

/** Multi-series line chart with a soft area fill under the first series. */
export function LineChart({
  series,
  labels,
  height = 150,
  yFormat = (n) => `${n}`,
}: {
  series: Series[];
  labels: string[];
  height?: number;
  yFormat?: (n: number) => string;
}) {
  const W = 640;
  const H = height;
  const padX = 8;
  const padY = 14;
  const n = labels.length;
  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => padX + (n <= 1 ? 0 : (i / (n - 1)) * (W - padX * 2));
  const y = (v: number) => H - padY - (v / max) * (H - padY * 2);
  const line = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = (vals: number[]) =>
    `${line(vals)} L${x(n - 1).toFixed(1)},${(H - padY).toFixed(1)} L${x(0).toFixed(1)},${(H - padY).toFixed(1)} Z`;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} preserveAspectRatio="none">
        {/* gridlines */}
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={padX} x2={W - padX} y1={padY + f * (H - padY * 2)} y2={padY + f * (H - padY * 2)}
            stroke="#262a33" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        ))}
        {series[0] && (
          <path d={area(series[0].values)} fill={series[0].color} opacity="0.12" />
        )}
        {series.map((s) => (
          <path key={s.name} d={line(s.values)} fill="none" stroke={s.color} strokeWidth="2"
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-[#5a606b]">
        <span>{labels[0]?.slice(5)}</span>
        <div className="flex gap-3">
          {series.map((s) => (
            <span key={s.name} className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
              {s.name} · {yFormat(Math.max(...s.values, 0))} peak
            </span>
          ))}
        </div>
        <span>{labels[n - 1]?.slice(5)}</span>
      </div>
    </div>
  );
}

/** Donut with a centred total and a legend. */
export function DonutChart({
  segments,
  size = 160,
  thickness = 24,
  centerLabel,
  centerValue,
}: {
  segments: { label: string; value: number; color: string }[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerValue?: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const C = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="flex items-center gap-5">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1d2027" strokeWidth={thickness} />
          {total > 0 &&
            segments.map((seg) => {
              const frac = seg.value / total;
              const dash = frac * C;
              const el = (
                <circle
                  key={seg.label}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={thickness}
                  strokeDasharray={`${dash} ${C - dash}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += dash;
              return el;
            })}
        </g>
        <text x="50%" y="47%" textAnchor="middle" className="fill-[#e6e8eb] font-mono" fontSize="22" fontWeight="700">
          {centerValue ?? total}
        </text>
        {centerLabel && (
          <text x="50%" y="60%" textAnchor="middle" className="fill-[#8b919c] font-mono" fontSize="10">
            {centerLabel}
          </text>
        )}
      </svg>
      <ul className="space-y-1.5 font-mono text-xs">
        {segments.map((seg) => (
          <li key={seg.label} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: seg.color }} />
            <span className="text-[#8b919c]">{seg.label}</span>
            <span className="ml-auto tabular-nums text-[#e6e8eb]">{seg.value}</span>
            <span className="w-9 text-right tabular-nums text-[#5a606b]">
              {total > 0 ? Math.round((seg.value / total) * 100) : 0}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Ranked horizontal bars — top paths, plan mix, anything label→value. */
export function BarRows({
  rows,
  color = "#9db4ff",
  unit = "",
}: {
  rows: { label: string; value: number }[];
  color?: string;
  unit?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (rows.length === 0) return <p className="font-mono text-xs text-[#5a606b]">No data yet.</p>;
  return (
    <ul className="space-y-2 font-mono text-xs">
      {rows.map((r) => (
        <li key={r.label} className="grid grid-cols-[1fr_auto] items-center gap-2">
          <div className="min-w-0">
            <div className="mb-1 flex justify-between gap-2">
              <span className="truncate text-[#8b919c]" title={r.label}>{r.label}</span>
              <span className="tabular-nums text-[#e6e8eb]">{unit}{r.value.toLocaleString()}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1d2027]">
              <div className="h-full rounded-full" style={{ width: `${(r.value / max) * 100}%`, background: color }} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
