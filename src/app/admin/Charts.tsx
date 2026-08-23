/**
 * The dashboard's chart vocabulary, drawn as SVG on the server.
 *
 * NO CHART LIBRARY, and that is a decision rather than an omission. The
 * Content-Security-Policy on this app is `default-src 'self'` with no CDN, so a
 * library would have to be bundled; the ones worth having are 40–150 KB of
 * client JavaScript, and every chart on this page is a fixed shape over at most
 * ninety numbers. Recharts would ship a rendering engine to draw ninety
 * rectangles. These are server components: the markup arrives already drawn,
 * there is nothing to hydrate, and the page works with JavaScript off.
 *
 * Every chart here carries a text equivalent — a `<title>` inside the SVG and a
 * legend or table beside it — because a chart that a screen reader announces as
 * "image" is a number the operator cannot read. The accessibility sweep in
 * `npm run smoke` fails the build if one goes missing.
 *
 * The one rule the whole file obeys: NOTHING IS INTERPOLATED, SMOOTHED OR
 * PROJECTED. A gap in the data is drawn as a gap. This is the admin surface of a
 * product whose entire pitch is that its numbers are checkable, and a dashboard
 * that draws a pretty curve through three real points is the same lie as an
 * invented ATS score.
 */
import type { ReactNode } from "react";
import { CountUp } from "./CountUp";

/* ── numbers ─────────────────────────────────────────────────────── */

/**
 * A change against the previous period of the same length.
 *
 * Renders NOTHING when the previous period is zero, rather than "+100%" or
 * "∞%". Going from 0 to 3 signups is not a percentage increase, it is three
 * signups, and the number beside this chip already says so.
 */
export function TrendChip({ now, before }: { now: number; before: number }) {
  if (before <= 0) {
    return (
      <span className="text-muted font-mono text-[10px] tracking-[0.1em] uppercase">
        {now > 0 ? "new" : "—"}
      </span>
    );
  }
  const change = ((now - before) / before) * 100;
  const flat = Math.abs(change) < 0.5;
  const up = change > 0;
  const tone = flat ? "var(--muted)" : up ? "var(--brand)" : "#a3271b";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[10px] tabular-nums"
      style={{ color: tone, background: "var(--surface-2)" }}
      title={`${now} this period against ${before} last period`}
    >
      <span aria-hidden>{flat ? "→" : up ? "↑" : "↓"}</span>
      {flat ? "level" : `${Math.abs(change).toFixed(change >= 10 ? 0 : 1)}%`}
    </span>
  );
}

export function KpiCard({
  label,
  value,
  sub,
  trend,
  accent,
  index = 0,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  trend?: { now: number; before: number };
  /** Paints the number in the brand colour. One card per row at most. */
  accent?: boolean;
  /** Position in its row, for the staggered reveal. */
  index?: number;
}) {
  // A plain string or number rolls up on arrival (CountUp); anything richer
  // is rendered as given.
  const shown =
    typeof value === "string" || typeof value === "number" ? <CountUp text={String(value)} /> : value;
  return (
    <div
      className="bg-surface border-border adm-card adm-reveal rounded-xl border p-4"
      style={{ ["--i" as string]: index }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-muted font-mono text-[10px] tracking-[0.12em] uppercase">{label}</p>
        {trend && <TrendChip now={trend.now} before={trend.before} />}
      </div>
      <p
        className="font-display mt-2 text-3xl leading-none font-bold tabular-nums"
        style={accent ? { color: "var(--brand)" } : undefined}
      >
        {shown}
      </p>
      {sub && <p className="text-muted mt-2 text-xs leading-snug">{sub}</p>}
    </div>
  );
}

export function StatusPill({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad" | "quiet";
  children: ReactNode;
}) {
  const colour =
    tone === "good"
      ? "var(--brand)"
      : tone === "warn"
        ? "var(--warn)"
        : tone === "bad"
          ? "#a3271b"
          : "var(--muted)";
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10px] tracking-[0.08em] whitespace-nowrap uppercase"
      style={{ color: colour, background: "var(--surface-2)" }}
    >
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: colour }} />
      {children}
    </span>
  );
}

/* ── the signups series ──────────────────────────────────────────── */

export type DayPoint = { date: string; count: number };

/**
 * Signups per day, as an area with a real baseline.
 *
 * Drawn with straight segments, not a spline. A smoothed curve through daily
 * counts invents days that did not happen — it dips below zero between two
 * zeros and overshoots a spike — and on a chart whose whole job is "how many
 * people signed up on Tuesday" that is not a stylistic choice.
 *
 * The empty days are IN the data (see `signupsByDay`), so a quiet fortnight is
 * a flat line at zero rather than two ticks pushed together.
 */
export function SignupArea({
  points,
  height = 132,
  id = "area",
  format = (v: number) => String(v),
  label = "per day",
}: {
  points: DayPoint[];
  height?: number;
  /** Unique per chart on a page — gradient and title ids. */
  id?: string;
  /** How a value prints in the hover label and the caption. */
  format?: (v: number) => string;
  label?: string;
}) {
  const width = 720;
  const pad = { top: 16, right: 4, bottom: 18, left: 4 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const peak = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((sum, p) => sum + p.count, 0);

  const x = (i: number) =>
    pad.left + (points.length <= 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v: number) => pad.top + plotH - (v / peak) * plotH;

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.count).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;
  const busiest = points.reduce((best, p, i) => (p.count > points[best].count ? i : best), 0);
  const colW = points.length > 1 ? plotW / (points.length - 1) : plotW;

  return (
    <figure className="adm-reveal m-0" style={{ ["--i" as string]: 2 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-labelledby={`${id}-title`}
        preserveAspectRatio="none"
        style={{ overflow: "visible" }}
      >
        <title id={`${id}-title`}>
          {`${label}, last ${points.length} days. ${format(total)} in total, peak ${format(points[busiest]?.count ?? 0)} on ${points[busiest]?.date}.`}
        </title>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--brand)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--brand)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.5, 1].map((frac) => (
          <g key={frac}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={y(peak * frac)}
              y2={y(peak * frac)}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="3 4"
            />
            <text
              x={width - pad.right}
              y={y(peak * frac) - 3}
              textAnchor="end"
              style={{ fontSize: "9px", fill: "var(--muted)", fontFamily: "var(--ff-mono)" }}
            >
              {format(Math.round(peak * frac))}
            </text>
          </g>
        ))}
        <path d={area} fill={`url(#${id}-fill)`} className="adm-fill" />
        <path
          d={line}
          fill="none"
          stroke="var(--brand)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          className="adm-draw"
        />
        {/* One hover column per day: the value appears where the pointer is.
            Pure CSS (.adm-hover) — no script — and a <title> for the keyboard
            and screen-reader path. */}
        {points.map((p, i) => (
          <g key={p.date} className="adm-hover">
            <title>{`${p.date}: ${format(p.count)}`}</title>
            <rect className="adm-hover-col" x={x(i) - colW / 2} y={0} width={colW} height={height} />
            <circle
              cx={x(i)}
              cy={y(p.count)}
              r="3.5"
              fill="var(--brand)"
              stroke="var(--surface)"
              strokeWidth="1.5"
            />
            <text
              className="adm-hover-val"
              x={x(i)}
              y={Math.max(10, y(p.count) - 8)}
              textAnchor={i < 3 ? "start" : i > points.length - 4 ? "end" : "middle"}
              style={{ fontSize: "10px", fill: "var(--ink-color)", fontFamily: "var(--ff-mono)", fontWeight: 600 }}
            >
              {format(p.count)}
            </text>
          </g>
        ))}
        {points[busiest] && points[busiest].count > 0 && (
          <circle cx={x(busiest)} cy={y(points[busiest].count)} r="3.5" fill="var(--brand)" />
        )}
      </svg>
      <figcaption className="text-muted mt-1 flex justify-between font-mono text-[10px] tracking-[0.08em] uppercase">
        <span>{points[0]?.date}</span>
        <span>
          peak {format(points[busiest]?.count ?? 0)} on {points[busiest]?.date}
        </span>
        <span>{points[points.length - 1]?.date}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Vertical bars — one per month (or any small series). They grow from the
 * baseline with a stagger; hovering shows the value; the peak is painted
 * brand-red so the eye lands on it first.
 */
export function Bars({
  data,
  height = 132,
  width = 360,
  format = (v: number) => String(v),
}: {
  data: { label: string; value: number; note?: string }[];
  height?: number;
  /** Coordinate width — match it roughly to the column it sits in, or the
      labels scale down to nothing. */
  width?: number;
  format?: (v: number) => string;
}) {
  const pad = { top: 16, right: 4, bottom: 22, left: 4 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const peak = Math.max(1, ...data.map((d) => d.value));
  const n = Math.max(1, data.length);
  const slot = plotW / n;
  const barW = Math.max(6, slot * 0.62);
  return (
    <figure className="adm-reveal m-0" style={{ ["--i" as string]: 2 }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Bars: ${data.map((d) => `${d.label} ${format(d.value)}`).join(", ")}`}
      >
        <line
          x1={pad.left}
          x2={width - pad.right}
          y1={pad.top + plotH}
          y2={pad.top + plotH}
          stroke="var(--border)"
        />
        {data.map((d, i) => {
          const h = (d.value / peak) * plotH;
          const cx = pad.left + i * slot + slot / 2;
          const isPeak = d.value === peak && d.value > 0;
          return (
            <g key={d.label} className="adm-hover">
              <title>{`${d.label}: ${format(d.value)}${d.note ? ` · ${d.note}` : ""}`}</title>
              <rect className="adm-hover-col" x={cx - slot / 2} y={0} width={slot} height={height} />
              <rect
                x={cx - barW / 2}
                y={pad.top + plotH - h}
                width={barW}
                height={Math.max(h, d.value > 0 ? 2 : 0)}
                rx="3"
                fill={isPeak ? "var(--brand)" : "var(--cta)"}
                opacity={isPeak ? 1 : 0.75}
                className="adm-grow-y"
                style={{ ["--i" as string]: i }}
              />
              <text
                x={cx}
                y={pad.top + plotH + 14}
                textAnchor="middle"
                style={{ fontSize: "9px", fill: "var(--muted)", fontFamily: "var(--ff-mono)", opacity: 1 }}
              >
                {d.label}
              </text>
              <text
                className="adm-hover-val"
                x={cx}
                y={Math.max(10, pad.top + plotH - h - 6)}
                textAnchor="middle"
                style={{ fontSize: "10px", fill: "var(--ink-color)", fontFamily: "var(--ff-mono)", fontWeight: 600 }}
              >
                {format(d.value)}
              </text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

/* ── proportions ─────────────────────────────────────────────────── */

export type Slice = { label: string; count: number; tone: string };

/**
 * A donut, with the legend carrying the actual numbers.
 *
 * The ring is the decoration; the list beside it is the data. That ordering is
 * deliberate — a reader who cannot judge a 7% arc by eye still gets an exact
 * count, and the SVG's own title says the same thing out loud.
 *
 * Drawn with stroke-dasharray on circles rather than arc paths: a full ring at
 * 100% is one circle, and an arc path for a single 100% slice degenerates into
 * a zero-length line that some renderers drop entirely.
 */
export function Donut({
  slices,
  centreLabel,
  centreValue,
}: {
  slices: Slice[];
  centreLabel: string;
  centreValue: number;
}) {
  const total = slices.reduce((sum, s) => sum + s.count, 0);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg width="132" height="132" viewBox="0 0 132 132" role="img" aria-labelledby="donut-title" className="adm-sweep">
        <title id="donut-title">
          {total === 0
            ? `${centreLabel}: nothing yet.`
            : `${centreLabel}: ${slices.map((s) => `${s.label} ${s.count}`).join(", ")}.`}
        </title>
        <circle cx="66" cy="66" r={radius} fill="none" stroke="var(--surface-2)" strokeWidth="16" />
        {total > 0 &&
          slices
            .filter((s) => s.count > 0)
            .map((s) => {
              const length = (s.count / total) * circumference;
              const dash = `${length} ${circumference - length}`;
              const el = (
                <circle
                  key={s.label}
                  cx="66"
                  cy="66"
                  r={radius}
                  fill="none"
                  stroke={s.tone}
                  strokeWidth="16"
                  strokeDasharray={dash}
                  strokeDashoffset={-offset}
                  transform="rotate(-90 66 66)"
                />
              );
              offset += length;
              return el;
            })}
        <text
          x="66"
          y="62"
          textAnchor="middle"
          className="font-display"
          style={{ fontSize: "24px", fontWeight: 700, fill: "var(--ink-color)" }}
        >
          {centreValue}
        </text>
        <text
          x="66"
          y="80"
          textAnchor="middle"
          style={{ fontSize: "9px", letterSpacing: "0.1em", fill: "var(--muted)" }}
        >
          {centreLabel.toUpperCase()}
        </text>
      </svg>
      <ul className="min-w-[10rem] flex-1 space-y-1.5">
        {slices.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2">
              <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.tone }} />
              {s.label}
            </span>
            <span className="text-muted font-mono text-xs tabular-nums">
              {s.count}
              {total > 0 && <span className="ml-1.5">{Math.round((s.count / total) * 100)}%</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A horizontal distribution — score bands, funnel steps, anything comparable.
 *
 * Bars are proportional to the LARGEST value present, not to a total, because
 * these are counts in independent buckets rather than shares of one thing.
 */
export function BandBars({
  rows,
}: {
  rows: { label: string; note?: string; count: number; tone?: string }[];
}) {
  const peak = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="space-y-2.5">
      {rows.map((r, i) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">
              {r.label}
              {r.note && <span className="text-muted ml-2 text-xs">{r.note}</span>}
            </span>
            <span className="text-muted font-mono text-xs tabular-nums">{r.count}</span>
          </div>
          <div className="bg-surface-2 mt-1 h-2 w-full overflow-hidden rounded-full">
            <div
              className="adm-grow-x h-full rounded-full"
              style={{
                ["--i" as string]: i,
                width: `${(r.count / peak) * 100}%`,
                background: r.tone ?? "var(--brand)",
                minWidth: r.count > 0 ? "3px" : "0",
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
