"use client";

import { useMemo, useState } from "react";

export type AccountRow = {
  id: string;
  email: string;
  name: string | null;
  plan: string;
  accessStatus: string;
  resumes: number;
  rebuilds: number;
  /** Smallest unit (paise), paid orders only. */
  paid: number;
  currency: string;
  /** Has an active pack/pass or a per-company unlock right now. */
  paying: boolean;
  createdAt: string;
  /** Last audit-log action; null = signed up and never did anything. */
  lastActiveAt: string | null;
};

type Segment = "all" | "active" | "paying" | "free" | "pending" | "blocked" | "idle";

const SEGMENTS: { key: Segment; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Every non-admin account." },
  { key: "active", label: "Active 30d", hint: "Did something in the last 30 days." },
  { key: "paying", label: "Paying", hint: "Active pass/pack or a company unlock right now." },
  { key: "free", label: "Free", hint: "Approved, never paid." },
  { key: "pending", label: "Pending", hint: "Waiting for approval." },
  { key: "blocked", label: "Blocked", hint: "Access removed." },
  { key: "idle", label: "Never uploaded", hint: "Approved, zero resumes — the drop-off." },
];

const STATUS_TONE: Record<string, string> = {
  approved: "var(--muted)",
  pending: "var(--warn)",
  blocked: "#a3271b",
};

const DAY = 86_400_000;

function money(paise: number, currency: string): string {
  if (!paise) return "—";
  const units = paise / 100;
  return currency === "INR" ? `₹${units.toLocaleString("en-IN")}` : `${units.toFixed(2)} ${currency}`;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const d = now - new Date(iso).getTime();
  if (d < 60_000) return "just now";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < DAY) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / DAY)}d ago`;
}

export function AccountTable({ rows, now }: { rows: AccountRow[]; now: number }) {
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("all");

  const counts = useMemo(() => {
    const c: Record<Segment, number> = { all: 0, active: 0, paying: 0, free: 0, pending: 0, blocked: 0, idle: 0 };
    for (const r of rows) {
      c.all++;
      if (r.lastActiveAt && now - new Date(r.lastActiveAt).getTime() <= 30 * DAY) c.active++;
      if (r.paying) c.paying++;
      if (r.accessStatus === "approved" && !r.paid && !r.paying) c.free++;
      if (r.accessStatus === "pending") c.pending++;
      if (r.accessStatus === "blocked") c.blocked++;
      if (r.accessStatus === "approved" && r.resumes === 0) c.idle++;
    }
    return c;
  }, [rows, now]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.email.toLowerCase().includes(q) && !(r.name ?? "").toLowerCase().includes(q)) return false;
      switch (segment) {
        case "active":
          return !!r.lastActiveAt && now - new Date(r.lastActiveAt).getTime() <= 30 * DAY;
        case "paying":
          return r.paying;
        case "free":
          return r.accessStatus === "approved" && !r.paid && !r.paying;
        case "pending":
          return r.accessStatus === "pending";
        case "blocked":
          return r.accessStatus === "blocked";
        case "idle":
          return r.accessStatus === "approved" && r.resumes === 0;
        default:
          return true;
      }
    });
  }, [rows, query, segment, now]);

  const picked = SEGMENTS.find((s) => s.key === segment)!;

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="account-filter" className="sr-only">
          Filter accounts by email or name
        </label>
        <input
          id="account-filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by email or name…"
          className="field min-w-[12rem] flex-1 text-sm"
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Segment">
        {SEGMENTS.map((s) => (
          <button
            key={s.key}
            type="button"
            aria-pressed={segment === s.key}
            onClick={() => setSegment(s.key)}
            title={s.hint}
            className="cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] uppercase transition-colors"
            style={
              segment === s.key
                ? { background: "var(--cta)", color: "var(--on-cta)", borderColor: "var(--cta)" }
                : { color: "var(--muted)", borderColor: "var(--line-2)" }
            }
          >
            {s.label} · {counts[s.key]}
          </button>
        ))}
      </div>

      <p className="text-muted mt-2 font-mono text-[10px] tracking-[0.08em] uppercase" aria-live="polite">
        {shown.length} of {rows.length} shown · {picked.hint}
      </p>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="border-border border-b text-left">
              <Th>Account</Th>
              <Th>Access</Th>
              <Th>Plan</Th>
              <Th className="text-right">Resumes</Th>
              <Th className="text-right">Rebuilds</Th>
              <Th className="text-right">Paid</Th>
              <Th className="text-right">Last active</Th>
              <Th className="text-right">Joined</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-border border-b last:border-0">
                <td className="max-w-[18rem] py-2.5 pr-4">
                  <span className="block truncate">{r.email}</span>
                  {r.name && <span className="text-muted block truncate text-xs">{r.name}</span>}
                </td>
                <td className="py-2.5 pr-4">
                  <span
                    className="font-mono text-[10px] tracking-[0.08em] uppercase"
                    style={{ color: STATUS_TONE[r.accessStatus] ?? "var(--muted)" }}
                  >
                    {r.accessStatus}
                  </span>
                </td>
                <td className="py-2.5 pr-4">
                  <span className={r.paying ? "text-brand font-medium" : "text-muted"}>{r.plan}</span>
                  {r.paying && r.plan === "free" && <span className="text-muted text-xs"> · unlock</span>}
                </td>
                <td className="py-2.5 pr-4 text-right font-mono tabular-nums">{r.resumes}</td>
                <td className="py-2.5 pr-4 text-right font-mono tabular-nums">{r.rebuilds}</td>
                <td className="py-2.5 pr-4 text-right font-mono tabular-nums">{money(r.paid, r.currency)}</td>
                <td className="text-muted py-2.5 pr-4 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  {ago(r.lastActiveAt, now)}
                </td>
                <td className="text-muted py-2.5 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  {new Date(r.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="text-muted py-6 text-center text-sm">
                  No account matches that.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      scope="col"
      className={`text-muted pb-2 pr-4 font-mono text-[10px] font-normal tracking-[0.12em] uppercase ${className}`}
    >
      {children}
    </th>
  );
}
