import { scoreColor } from "@/lib/reportTypes";

/**
 * The score over time.
 *
 * `Resume.score` is overwritten on every read, so the question a user most
 * wants answered — did the thing I changed help? — had no data behind it at
 * all. It does now: every upload, every kept rebuild and every edit writes a
 * ScoreEvent, and this is the one view where the product stops describing a
 * document and starts describing a person getting better at something.
 *
 * Rendered inside the Scorecard. The application tracker that used to sit
 * beside it moved to its own account-wide page (/app/applications); the two
 * types below are still shared with that page and the workspace.
 */

export type ScorePoint = {
  id: string;
  score: number;
  grade: string;
  source: string;
  variantLabel: string | null;
  createdAt: string;
};

export type ApplicationRow = {
  id: string;
  company: string;
  role: string;
  status: string;
  variantLabel: string | null;
  notes: string | null;
  appliedAt: string;
};

export const STATUS_LABELS: Record<string, string> = {
  sent: "Sent",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

const SOURCE_LABELS: Record<string, string> = {
  upload: "Uploaded",
  rescore: "Re-measured",
  variant: "Rebuild",
  edit: "Your edit",
};

export function ScoreHistory({ history }: { history: ScorePoint[] }) {
  if (history.length === 0) {
    return (
      <section>
        <h2 className="font-display text-2xl font-semibold">Your score over time</h2>
        <p className="text-muted mt-2 text-sm">
          Nothing recorded yet. Every upload, rebuild and edit adds a point here.
        </p>
      </section>
    );
  }

  const scores = history.map((h) => h.score);
  const min = Math.min(...scores, 0);
  const max = Math.max(...scores, 100);
  const first = history[0];
  const latest = history[history.length - 1];
  const change = latest.score - first.score;

  // Plotted by index rather than by date. The gaps between edits are minutes and
  // the gaps between sessions are weeks, so a time axis would compress an
  // afternoon's work into one pixel and stretch a fortnight of nothing across
  // the chart.
  const width = 100;
  const height = 34;
  const points = history.map((point, i) => {
    const x = history.length === 1 ? width / 2 : (i / (history.length - 1)) * width;
    const y = height - ((point.score - min) / Math.max(1, max - min)) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <section>
      <h2 className="font-display text-2xl font-semibold">Your score over time</h2>
      <p className="text-muted mt-2 max-w-2xl leading-relaxed">
        The same ruler every time — a pure function of the text, so a change in this
        line is a change in the document rather than a change in our mood.
      </p>

      <div className="bg-surface border-border mt-5 rounded-xl border p-5">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <p className="font-display text-3xl font-bold tabular-nums">{latest.score}</p>
          <p className="text-sm">
            {change > 0 ? (
              <span style={{ color: "var(--brand)" }}>
                +{change} since your first measurement
              </span>
            ) : change < 0 ? (
              <span style={{ color: "#a3271b" }}>{change} since your first measurement</span>
            ) : (
              <span className="text-muted">Unchanged since your first measurement</span>
            )}
          </p>
        </div>

        {history.length > 1 && (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="mt-4 h-24 w-full"
            role="img"
            aria-label={`Score history: ${scores.join(", ")}`}
          >
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke="var(--brand)"
              strokeWidth="1.2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
            {/* Zero-length lines with a round cap, not circles.
                The viewBox is stretched with preserveAspectRatio="none" — which
                is right for the line, a sparkline is meant to fill its box — and
                that scales x and y by different factors. A <circle> in that
                space is drawn as an ellipse: these markers came out as wide flat
                smears. `vector-effect` does not help, because it governs stroke
                WIDTH and the circles were filled.
                A zero-length subpath with stroke-linecap="round" renders as a
                dot of exactly stroke-width across, and non-scaling-stroke keeps
                that width in screen pixels — so it is round at any container
                size. */}
            {history.map((point, i) => {
              const [x, y] = points[i].split(",");
              return (
                <line
                  key={point.id}
                  x1={x}
                  y1={y}
                  x2={x}
                  y2={y}
                  stroke={scoreColor(point.score)}
                  strokeWidth={5}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </svg>
        )}

        <ul className="border-border mt-4 flex flex-col gap-2 border-t pt-4 text-sm">
          {[...history].reverse().slice(0, 8).map((point) => (
            <li key={point.id} className="flex flex-wrap items-baseline justify-between gap-2">
              <span>
                {SOURCE_LABELS[point.source] ?? point.source}
                {point.variantLabel ? ` · ${point.variantLabel}` : ""}
              </span>
              <span className="text-muted font-mono text-xs tabular-nums">
                {point.score} · {new Date(point.createdAt).toLocaleDateString("en-IN", {
                  day: "numeric",
                  month: "short",
                })}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
