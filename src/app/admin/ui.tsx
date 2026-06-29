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
