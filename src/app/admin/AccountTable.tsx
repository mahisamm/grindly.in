"use client";

import { useMemo, useState } from "react";

export type AccountRow = {
  id: string;
  email: string;
  plan: string;
  accessStatus: string;
  resumes: number;
  createdAt: string;
};

/**
 * Approved is NOT a colour.
 *
 * It was the brand red, and blocked was the danger red, so the column's two
 * opposite meanings were the same hue and the eye had to read every word. The
 * palette has no green to reach for and inventing one for this table would put
 * a colour in the product that exists nowhere else. So the ordinary state is
 * quiet and the two that need an operator are loud — which is what a status
 * column is for.
 */
const STATUS_TONE: Record<string, string> = {
  approved: "var(--muted)",
  pending: "var(--warn)",
  blocked: "#a3271b",
};

/**
 * The account list, with a filter box.
 *
 * The filter is the one genuinely interactive thing on this dashboard, and it
 * earns its JavaScript: the operator's real question is "what happened to
 * priya@" and the alternative is Ctrl-F over a table that is paginated. It
 * filters rows already in the page rather than querying — the list is capped at
 * fifty on the server, so there is nothing to fetch and nothing to wait for.
 *
 * With JavaScript off the input simply does nothing and every row is visible,
 * which is the correct degradation for a control that only ever REMOVES rows.
 */
export function AccountTable({ rows }: { rows: AccountRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<string>("all");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (status === "all" || r.accessStatus === status) &&
        (!q || r.email.toLowerCase().includes(q)),
    );
  }, [rows, query, status]);

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="account-filter" className="sr-only">
          Filter accounts by email
        </label>
        <input
          id="account-filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by email…"
          className="field min-w-[12rem] flex-1 text-sm"
        />
        <div className="flex gap-1.5" role="group" aria-label="Filter by access status">
          {["all", "approved", "pending", "blocked"].map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
              className="cursor-pointer rounded-full border px-3 py-1.5 font-mono text-[10px] tracking-[0.08em] uppercase transition-colors"
              style={
                status === s
                  ? { background: "var(--cta)", color: "var(--on-cta)", borderColor: "var(--cta)" }
                  : { color: "var(--muted)", borderColor: "var(--line-2)" }
              }
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <p className="text-muted mt-2 font-mono text-[10px] tracking-[0.08em] uppercase" aria-live="polite">
        {shown.length} of {rows.length} shown
      </p>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-sm">
          <thead>
            <tr className="border-border border-b text-left">
              <Th>Email</Th>
              <Th>Access</Th>
              <Th>Plan</Th>
              <Th className="text-right">Resumes</Th>
              <Th className="text-right">Joined</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id} className="border-border border-b last:border-0">
                <td className="max-w-[18rem] truncate py-2.5 pr-4">{r.email}</td>
                <td className="py-2.5 pr-4">
                  <span
                    className="font-mono text-[10px] tracking-[0.08em] uppercase"
                    style={{ color: STATUS_TONE[r.accessStatus] ?? "var(--muted)" }}
                  >
                    {r.accessStatus}
                  </span>
                </td>
                <td className="text-muted py-2.5 pr-4">{r.plan}</td>
                <td className="py-2.5 pr-4 text-right font-mono tabular-nums">{r.resumes}</td>
                <td className="text-muted py-2.5 text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  {new Date(r.createdAt).toLocaleDateString("en-IN", {
                    day: "numeric",
                    month: "short",
                  })}
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={5} className="text-muted py-6 text-center text-sm">
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
