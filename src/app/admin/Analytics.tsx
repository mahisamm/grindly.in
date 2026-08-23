import type { ConversionStats, RevenueSeries, TicketStats, TrafficStats } from "@/lib/adminStats";
import { KpiCard, SignupArea, BandBars, Bars, Donut } from "./Charts";
import { Section, StatGrid, Stat } from "./Panels";

/*
 * The analytics panels. Server components; SVG from Charts.tsx; every number
 * a count of rows. Each Section has ONE short line under its title and folds
 * the method behind "How this is counted" — the page reads as numbers and
 * charts first, the footnotes on demand.
 */

export function money(smallest: number, currency: string): string {
  const units = smallest / 100;
  if (currency === "INR") return `₹${units.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
  return `${units.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${currency}`;
}
const pct = (v: number | null) => (v === null ? "—" : `${v}%`);
const n = (v: number) => v.toLocaleString("en-IN");

/* ── the dashboard's top row ─────────────────────────────────────── */

export function HeroStrip({
  c,
  t,
  r,
  tk,
  activeWeek,
  activeWeekBefore,
}: {
  c: ConversionStats;
  t: TrafficStats;
  r: RevenueSeries;
  tk: TicketStats;
  activeWeek: number;
  activeWeekBefore: number;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      <KpiCard
        index={0}
        label="Active users · 30d"
        value={n(c.activeMonth)}
        sub={`${c.approved} approved accounts`}
        trend={{ now: activeWeek, before: activeWeekBefore }}
      />
      <KpiCard index={1} label="Paying now" value={n(c.payingNow)} sub={`${c.everPaid} ever paid`} accent />
      <KpiCard
        index={2}
        label="Conversion"
        value={pct(c.rateLifetime)}
        sub={`ever paid ÷ approved · ${pct(c.rateActive)} this month`}
      />
      <KpiCard index={3} label="Revenue · 30d" value={money(r.month, r.currency)} sub={`${money(r.allTime, r.currency)} all time`} />
      <KpiCard index={4} label="Views today" value={n(t.today.views)} sub={`${t.today.visitors} visitors · ${t.activeNow} on the site now`} />
      <KpiCard
        index={5}
        label="Needs a person"
        value={n(tk.awaitingYou)}
        sub={`${tk.withAssistant} with the assistant`}
        accent={tk.awaitingYou > 0}
      />
    </div>
  );
}

/* ── traffic ─────────────────────────────────────────────────────── */

export function TrafficPanel({ t, index = 0 }: { t: TrafficStats; index?: number }) {
  const started = t.firstSeen
    ? t.firstSeen.toLocaleDateString("en-IN", { day: "numeric", month: "short" })
    : null;
  return (
    <Section
      index={index}
      title="Traffic"
      note={`Who is visiting, and where. ${started ? `Tracking since ${started}.` : "Tracking starts with this deploy."}`}
      detail="Page views from the in-page beacon: one row per navigation, an anonymous first-party cookie for 'visitors', the user id when signed in. No IP, no fingerprint; obvious bots skipped; the admin pages themselves excluded. Days are UTC."
    >
      <StatGrid>
        <KpiCard index={0} label="On the site now" value={n(t.activeNow)} sub="distinct visitors · last 5 min" accent />
        <KpiCard index={1} label="Today" value={n(t.today.views)} sub={`${t.today.visitors} visitors · ${t.today.signedIn} signed in`} />
        <KpiCard index={2} label="Last 7 days" value={n(t.week.views)} sub={`${t.week.visitors} visitors · ${t.week.signedIn} signed in`} />
        <KpiCard index={3} label="Last 30 days" value={n(t.month.views)} sub={`${t.month.visitors} visitors · ${t.month.signedIn} signed in`} />
      </StatGrid>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="bg-surface border-border adm-card rounded-xl border p-4">
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Page views per day · 30 days</p>
          <div className="mt-2">
            <SignupArea points={t.byDay} height={160} id="traffic" label="Page views" format={n} />
          </div>
        </div>
        <div className="bg-surface border-border adm-card rounded-xl border p-4">
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Most viewed · 30 days</p>
          <div className="mt-3">
            {t.topPaths.length ? (
              <BandBars rows={t.topPaths.map((p) => ({ label: p.path, count: p.views }))} />
            ) : (
              <p className="text-muted text-sm">Nothing recorded yet.</p>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── revenue ─────────────────────────────────────────────────────── */

export function RevenuePanel({
  r,
  paidOrders,
  payingUsers,
  accounts,
  index = 1,
}: {
  r: RevenueSeries;
  paidOrders: number;
  payingUsers: number;
  accounts: number;
  index?: number;
}) {
  const cur = r.currency;
  const months = r.byMonth.map((m) => ({
    label: new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short" }),
    value: Math.round(m.amount / 100),
    note: `${m.orders} order${m.orders === 1 ? "" : "s"}`,
  }));
  const arpu = accounts > 0 ? r.allTime / accounts : 0;
  return (
    <Section
      index={index}
      title="Revenue"
      note={`Money in, by the day it was paid. ${paidOrders} paid order${paidOrders === 1 ? "" : "s"} from ${payingUsers} account${payingUsers === 1 ? "" : "s"}.`}
      detail={`Paid orders only, by paid_at, in ${cur}. An order created and abandoned is not revenue. Days are UTC.${r.otherCurrencies.length ? ` Also: ${r.otherCurrencies.map((o) => `${money(o.amount, o.currency)} across ${o.orders} order${o.orders === 1 ? "" : "s"}`).join("; ")} — listed apart, not summed in.` : ""} Revenue per account = all-time revenue ÷ every account, not a forecast.`}
    >
      <StatGrid>
        <KpiCard index={0} label="Today" value={money(r.today, cur)} />
        <KpiCard index={1} label="Last 7 days" value={money(r.week, cur)} />
        <KpiCard index={2} label="Last 30 days" value={money(r.month, cur)} accent />
        <KpiCard index={3} label="All time" value={money(r.allTime, cur)} sub={`${money(Math.round(arpu), cur)} per account`} />
      </StatGrid>
      <div className="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <div className="bg-surface border-border adm-card rounded-xl border p-4">
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Revenue per day · 30 days</p>
          <div className="mt-2">
            <SignupArea
              points={r.byDay.map((d) => ({ date: d.date, count: Math.round(d.count / 100) }))}
              height={160}
              id="revenue"
              label="Revenue"
              format={(v) => money(v * 100, cur)}
            />
          </div>
        </div>
        <div className="bg-surface border-border adm-card rounded-xl border p-4">
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">By month · 12 months</p>
          <div className="mt-2">
            <Bars data={months} height={160} format={(v) => money(v * 100, cur)} />
          </div>
        </div>
      </div>
    </Section>
  );
}

/* ── product quality ─────────────────────────────────────────────── */

export function ProductPanel({
  quality,
  work,
  index = 2,
}: {
  quality: {
    medianScore: number | null;
    medianGain: number | null;
    atOrAboveFloor: number;
    keptVariants: number;
    scoreBands: { label: string; range: string; count: number }[];
  };
  work: { resumes: number; rebuilds: number; runsByStatus: Record<string, number>; exports: number; editorBuilds: number; coverLetters: number };
  index?: number;
}) {
  const runs = work.runsByStatus;
  const runTotal = Object.values(runs).reduce((a, b) => a + b, 0);
  const failed = runs.failed ?? 0;
  return (
    <Section
      index={index}
      title="Is the product any good"
      note="What it measured and what it produced — the score is arithmetic over the resume text, so these move only when documents do."
      detail="Median score is across every resume ever measured. Median gain is the points a KEPT rebuild adds over the resume it came from. 'Cleared the floor' counts kept rebuilds at or above the shippable floor. Failed runs are runs our side could not complete; 'beaten by the original' is a success — nothing we made was better, and we said so."
    >
      <StatGrid>
        <Stat index={0} label="Median score" value={quality.medianScore ?? "—"} sub="across every resume measured" tone="good" />
        <Stat
          index={1}
          label="Median gain"
          value={quality.medianGain === null ? "—" : `+${quality.medianGain}`}
          sub="points a kept rebuild adds"
        />
        <Stat
          index={2}
          label="Cleared the floor"
          value={quality.keptVariants ? `${Math.round((quality.atOrAboveFloor / quality.keptVariants) * 100)}%` : "—"}
          sub={`${quality.atOrAboveFloor} of ${quality.keptVariants} kept rebuilds`}
        />
        <Stat
          index={3}
          label="Runs that failed"
          value={runTotal ? `${Math.round((failed / runTotal) * 100)}%` : "—"}
          sub={`${failed} of ${runTotal} · ${work.exports} exports · ${work.editorBuilds} editor builds`}
          tone={runTotal && failed / runTotal > 0.15 ? "warn" : undefined}
        />
      </StatGrid>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="bg-surface border-border adm-card rounded-xl border p-5">
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Rebuild outcomes · every run</p>
          <div className="mt-3">
            <Donut
              centreLabel="runs"
              centreValue={runTotal}
              slices={[
                { label: "Kept a rebuild", count: runs.done ?? 0, tone: "var(--brand)" },
                { label: "Beaten by the original", count: runs.empty ?? 0, tone: "var(--warn)" },
                { label: "Failed", count: failed, tone: "var(--ink-color)" },
                { label: "Cancelled", count: runs.cancelled ?? 0, tone: "var(--line-2)" },
                { label: "Running now", count: runs.running ?? 0, tone: "var(--muted)" },
              ]}
            />
          </div>
        </div>
        <div className="bg-surface border-border adm-card rounded-xl border p-5">
          <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">Score distribution · grade bands</p>
          <div className="mt-3">
            <BandBars
              rows={quality.scoreBands.map((b) => ({
                label: b.label,
                note: b.range,
                count: b.count,
                tone: b.label === "A" || b.label === "B" ? "var(--brand)" : b.label === "C" ? "var(--warn)" : "#a3271b",
              }))}
            />
          </div>
        </div>
      </div>
    </Section>
  );
}
