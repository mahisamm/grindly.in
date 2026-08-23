import type { ConversionStats, RevenueSeries, TrafficStats } from "@/lib/adminStats";
import { KpiCard, SignupArea, BandBars } from "./Charts";
import { Section, StatGrid, Stat } from "./Panels";

/*
 * The new analytics panels. Server components, SVG from Charts.tsx, every
 * number a count of rows — the same rule as the rest of the admin page:
 * each panel says what it was counted from.
 */

function pct(v: number | null): string {
  return v === null ? "—" : `${v}%`;
}

function money(smallest: number, currency: string): string {
  const units = smallest / 100;
  if (currency === "INR") return `₹${units.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  return `${units.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
}

/* ── conversion: the dashboard's top row ─────────────────────────── */

export function ConversionRow({ c }: { c: ConversionStats }) {
  return (
    <Section
      title="Who is here, who pays"
      note="Active = did something in the last 30 days (audit log). Paying now = a live pass/pack or a per-company unlock. Ever paid = at least one paid order. Rates are ratios of those counts, nothing modelled."
    >
      <StatGrid>
        <Stat label="Active users · 30d" value={String(c.activeMonth)} sub={`of ${c.approved} approved`} />
        <Stat label="Paying now" value={String(c.payingNow)} sub={`${c.everPaid} ever paid`} tone="good" />
        <Stat
          label="Conversion · lifetime"
          value={pct(c.rateLifetime)}
          sub="ever paid ÷ approved accounts"
          tone={c.rateLifetime && c.rateLifetime > 0 ? "good" : undefined}
        />
        <Stat
          label="Conversion · active"
          value={pct(c.rateActive)}
          sub={`${c.paidThisMonth} paid this month ÷ ${c.activeMonth} active`}
          tone={c.rateActive && c.rateActive > 0 ? "good" : undefined}
        />
      </StatGrid>
    </Section>
  );
}

/* ── traffic ─────────────────────────────────────────────────────── */

export function TrafficPanel({ t }: { t: TrafficStats }) {
  const started = t.firstSeen ? t.firstSeen.toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : null;
  return (
    <Section
      title="Traffic"
      note={`Page views from the in-page beacon: one row per navigation, an anonymous first-party cookie for "visitors", the user id when signed in. No IP, no fingerprint; obvious bots skipped; the admin pages themselves excluded. Days are UTC.${started ? ` Tracking since ${started}.` : " Tracking starts with this deploy — numbers fill in from here."}`}
    >
      <StatGrid>
        <KpiCard label="On the site now" value={t.activeNow} sub="distinct visitors · last 5 min" accent />
        <KpiCard label="Today" value={t.today.views} sub={`${t.today.visitors} visitors · ${t.today.signedIn} signed in`} />
        <KpiCard label="Last 7 days" value={t.week.views} sub={`${t.week.visitors} visitors · ${t.week.signedIn} signed in`} />
        <KpiCard label="Last 30 days" value={t.month.views} sub={`${t.month.visitors} visitors · ${t.month.signedIn} signed in`} />
      </StatGrid>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Page views per day · 30 days</p>
          <SignupArea points={t.byDay} height={140} />
        </div>
        <div>
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Most viewed · 30 days</p>
          {t.topPaths.length ? (
            <BandBars rows={t.topPaths.map((p) => ({ label: p.path, count: p.views }))} />
          ) : (
            <p className="text-muted mt-3 text-sm">Nothing recorded yet.</p>
          )}
        </div>
      </div>
    </Section>
  );
}

/* ── revenue ─────────────────────────────────────────────────────── */

export function RevenuePanel({ r }: { r: RevenueSeries }) {
  const cur = r.currency;
  const monthRows = r.byMonth.map((m) => ({
    label: new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" }),
    note: `${m.orders} order${m.orders === 1 ? "" : "s"}`,
    count: Math.round(m.amount / 100),
  }));
  return (
    <Section
      title="Revenue"
      note={`Paid orders only, by the day they were PAID, in ${cur}. An order created and abandoned is not revenue. Days are UTC.${r.otherCurrencies.length ? ` Also: ${r.otherCurrencies.map((o) => `${money(o.amount, o.currency)} across ${o.orders} order${o.orders === 1 ? "" : "s"}`).join("; ")} — listed apart, not summed in.` : ""}`}
    >
      <StatGrid>
        <KpiCard label="Today" value={money(r.today, cur)} />
        <KpiCard label="Last 7 days" value={money(r.week, cur)} />
        <KpiCard label="Last 30 days" value={money(r.month, cur)} accent />
        <KpiCard label="All time" value={money(r.allTime, cur)} />
      </StatGrid>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div>
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">
            Revenue per day · 30 days ({cur}, whole units)
          </p>
          <SignupArea points={r.byDay.map((d) => ({ date: d.date, count: Math.round(d.count / 100) }))} height={140} />
        </div>
        <div>
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">By month · 12 months</p>
          <BandBars rows={monthRows} />
        </div>
      </div>
    </Section>
  );
}
