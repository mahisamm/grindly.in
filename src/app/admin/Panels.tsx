import { scoreColor } from "@/lib/reportTypes";

/**
 * The reusable pieces of the admin page.
 *
 * Split out because the page was becoming one 400-line component where a
 * heading and a number were spelled slightly differently in six places.
 */

export function Section({
  title,
  note,
  children,
}: {
  title: string;
  /** What the numbers below are counted FROM. Every panel has one. */
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="font-mono text-[11px] tracking-[0.14em] uppercase opacity-60">{title}</h2>
      {note && <p className="text-muted mt-1.5 max-w-2xl text-xs leading-relaxed">{note}</p>}
      {children}
    </section>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  /** The second line. Use it for the denominator, never for a boast. */
  sub?: string;
  tone?: "good" | "bad" | "warn";
}) {
  const colour =
    tone === "good" ? "var(--brand)" : tone === "bad" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : undefined;
  return (
    <div className="bg-surface border-border rounded-xl border p-4">
      <p className="font-mono text-[10px] tracking-[0.12em] uppercase opacity-60">{label}</p>
      <p className="font-display mt-1.5 text-2xl font-bold tabular-nums" style={{ color: colour }}>
        {value}
      </p>
      {sub && <p className="text-muted mt-1 text-xs leading-snug">{sub}</p>}
    </div>
  );
}

/**
 * The funnel, drawn as bars rather than a percentage table.
 *
 * Counted in DISTINCT ACCOUNTS at each step, not events — one enthusiastic user
 * running forty rebuilds must not look like forty people getting value. The
 * widest bar is always the first step, so the shape of the drop-off is the
 * thing you see.
 */
export function Funnel({ steps }: { steps: { label: string; count: number; note: string }[] }) {
  const top = Math.max(1, steps[0]?.count ?? 1);
  return (
    <ul className="mt-3 flex flex-col gap-3">
      {steps.map((s, i) => {
        const share = Math.round((s.count / top) * 100);
        return (
          <li key={s.label}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">{s.label}</span>
              <span className="text-muted font-mono text-xs tabular-nums">
                {s.count}
                {/* No second dimming. This span is already inside `text-muted`,
                    so `opacity-60` on top of it computed to #8d877d on paper —
                    3.03:1, under the 4.5 that 12px text needs. The percentage
                    is secondary because of where it sits and what it says, not
                    because it is faded twice. */}
                {i > 0 && <span> · {share}%</span>}
              </span>
            </div>
            <div className="bg-surface-2 mt-1.5 h-2 w-full overflow-hidden rounded-full">
              <div
                className="h-full rounded-full"
                style={{ width: `${share}%`, background: "var(--brand)" }}
              />
            </div>
            <p className="text-muted mt-1 text-xs leading-snug">{s.note}</p>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Signups per day.
 *
 * Bars, not a line: the counts are small integers and a line between 0 and 2
 * implies a continuum that is not there. Empty days are included — a chart that
 * omits them makes a quiet fortnight look like steady growth.
 */
export function DailyBars({ data }: { data: { date: string; count: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="bg-surface border-border mt-3 rounded-xl border p-4">
      <div className="flex h-24 items-end gap-[2px]" role="img" aria-label={`Signups per day: ${data.map((d) => `${d.date} ${d.count}`).join(", ")}`}>
        {data.map((d) => (
          <div
            key={d.date}
            title={`${d.date}: ${d.count}`}
            className="flex-1 rounded-t"
            style={{
              // A day with no signups still gets a visible sliver, so the axis
              // reads as a timeline rather than as a gap in the data.
              height: `${Math.max(2, (d.count / max) * 100)}%`,
              background: d.count ? "var(--brand)" : "var(--border)",
            }}
          />
        ))}
      </div>
      <div className="text-muted mt-2 flex justify-between font-mono text-[10px]">
        <span>{data[0]?.date}</span>
        <span>{data[data.length - 1]?.date}</span>
      </div>
    </div>
  );
}

/** A score with the band colour the rest of the product uses for it. */
export function ScoreStat({ label, score, sub }: { label: string; score: number | null; sub: string }) {
  return (
    <div className="bg-surface border-border rounded-xl border p-4">
      <p className="font-mono text-[10px] tracking-[0.12em] uppercase opacity-60">{label}</p>
      <p
        className="font-display mt-1.5 text-2xl font-bold tabular-nums"
        style={{ color: score === null ? undefined : scoreColor(score) }}
      >
        {score === null ? "—" : score}
      </p>
      <p className="text-muted mt-1 text-xs leading-snug">{sub}</p>
    </div>
  );
}
