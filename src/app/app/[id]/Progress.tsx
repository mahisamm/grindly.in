"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { scoreColor } from "@/lib/reportTypes";

/**
 * Two things the product measured and never showed anyone.
 *
 * THE SCORE OVER TIME. `Resume.score` is overwritten on every read, so the
 * question a user most wants answered — did the thing I changed help? — had no
 * data behind it at all. It does now: every upload, every kept rebuild and
 * every edit writes a ScoreEvent, and this is the one screen where the product
 * stops describing a document and starts describing a person getting better at
 * something.
 *
 * WHERE IT WENT. Grindly does not submit anything and does not read anyone's
 * inbox, so every row here is typed. What justifies it existing in a database
 * rather than a spreadsheet is the version column: which rebuild went to which
 * company. That is the join that turns "I applied to 40 places" into "the
 * tailored one got three replies out of nine".
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

const STATUS_LABELS: Record<string, string> = {
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

export function ProgressPanel({
  resumeId,
  history,
  applications,
  variantLabels,
}: {
  resumeId: string;
  history: ScorePoint[];
  applications: ApplicationRow[];
  /** The documents that exist to have been sent. */
  variantLabels: string[];
}) {
  return (
    <div className="flex flex-col gap-10">
      <ScoreHistory history={history} />
      <Tracker resumeId={resumeId} applications={applications} variantLabels={variantLabels} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function ScoreHistory({ history }: { history: ScorePoint[] }) {
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

// ---------------------------------------------------------------------------

function Tracker({
  resumeId,
  applications,
  variantLabels,
}: {
  resumeId: string;
  applications: ApplicationRow[];
  variantLabels: string[];
}) {
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [role, setRole] = useState("");
  const [variantLabel, setVariantLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resumeId, company, role, variantLabel }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Could not save that.");
        return;
      }
      setCompany("");
      setRole("");
      router.refresh();
    } catch {
      setError("We could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function update(id: string, status: string) {
    await fetch(`/api/applications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }).catch(() => null);
    router.refresh();
  }

  async function remove(id: string) {
    await fetch(`/api/applications/${id}`, { method: "DELETE" }).catch(() => null);
    router.refresh();
  }

  // The count that makes the version column worth having.
  const replies = applications.filter((a) =>
    ["screening", "interview", "offer"].includes(a.status),
  ).length;

  return (
    <section className="border-border border-t pt-10">
      <h2 className="font-display text-2xl font-semibold">Where you sent it</h2>
      <p className="text-muted mt-2 max-w-2xl leading-relaxed">
        Typed by you, because Grindly does not submit anything on your behalf — bulk
        applying through job boards breaks their terms and gets accounts banned. What
        this is for is the one thing a spreadsheet cannot tell you: which version of
        your resume went to whom.
      </p>

      <form onSubmit={add} className="mt-5 flex flex-wrap items-end gap-3">
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1.5 block text-sm font-medium">Company</span>
          <input
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            maxLength={120}
            className="field w-full"
            placeholder="Freshworks"
          />
        </label>
        <label className="min-w-[12rem] flex-1">
          <span className="mb-1.5 block text-sm font-medium">Role</span>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            maxLength={120}
            className="field w-full"
            placeholder="Backend Engineer"
          />
        </label>
        {variantLabels.length > 0 && (
          <label className="min-w-[10rem]">
            <span className="mb-1.5 block text-sm font-medium">Which version</span>
            <select
              value={variantLabel}
              onChange={(e) => setVariantLabel(e.target.value)}
              className="field w-full"
            >
              <option value="">Original</option>
              {variantLabels.map((label) => (
                <option key={label} value={label}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={busy || !company.trim()} className="btn btn-primary">
          {busy ? "Saving…" : "Log it"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm" style={{ color: "#a3271b" }}>
          {error}
        </p>
      )}

      {applications.length > 0 && (
        <>
          <p className="text-muted mt-6 text-sm">
            {applications.length} logged · {replies} moved past &ldquo;sent&rdquo;
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-border border-b text-left">
                  {["Company", "Role", "Version", "Sent", "Status", ""].map((h) => (
                    <th
                      key={h}
                      className="text-muted py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.1em] uppercase"
                    >
                      {h || " "}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {applications.map((a) => (
                  <tr key={a.id} className="border-border border-b">
                    <td className="py-2 pr-4">{a.company}</td>
                    <td className="text-muted py-2 pr-4">{a.role || "—"}</td>
                    <td className="text-muted py-2 pr-4">{a.variantLabel || "Original"}</td>
                    <td className="text-muted py-2 pr-4 whitespace-nowrap">
                      {new Date(a.appliedAt).toLocaleDateString("en-IN", {
                        day: "numeric",
                        month: "short",
                      })}
                    </td>
                    <td className="py-2 pr-4">
                      <label className="sr-only" htmlFor={`status-${a.id}`}>
                        Status for {a.company}
                      </label>
                      <select
                        id={`status-${a.id}`}
                        value={a.status}
                        onChange={(e) => void update(a.id, e.target.value)}
                        className="field py-1 text-xs"
                      >
                        {Object.entries(STATUS_LABELS).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2">
                      <button
                        onClick={() => void remove(a.id)}
                        aria-label={`Remove the application to ${a.company}`}
                        className="text-muted hover:text-ink cursor-pointer text-xs"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
