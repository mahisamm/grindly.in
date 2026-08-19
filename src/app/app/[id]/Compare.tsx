"use client";

import { useState } from "react";
import type { Fidelity, Report } from "@/lib/reportTypes";
import { BAND_LABELS } from "@/lib/reportTypes";

/**
 * Your resume beside the rebuild, on the same ruler.
 *
 * The product's entire claim is comparative — "we measured your file, rebuilt
 * it, and measured the rebuild the same way" — and the interface never once put
 * the two next to each other. The scores appeared on different tabs, the
 * fidelity count appeared on a card with no baseline beside it, and the band
 * breakdown that explains WHERE the difference came from was only ever shown
 * for one document at a time.
 *
 * Three views, because there are three genuinely different questions:
 *
 *   Bands     — which of the five parts of the score moved, and by how much.
 *   Facts     — what a parser could recover from each file. The headline claim.
 *   Documents — the PDF itself, next to the text a parser reads off it.
 */
export function Compare({
  baseline,
  baselineLabel,
  variantLabel,
  variantReport,
  variantFidelity,
  variantId,
  originalText,
}: {
  baseline: Report | null;
  baselineLabel: string;
  variantLabel: string;
  variantReport: Report | null;
  variantFidelity: Fidelity | null;
  variantId: string;
  originalText: string;
}) {
  const [view, setView] = useState<"bands" | "facts" | "documents">("bands");

  if (!baseline || !variantReport) {
    return (
      <p className="text-muted text-sm">
        There is no measured report for one of these two, so there is nothing honest
        to compare.
      </p>
    );
  }

  const bands = Object.keys(BAND_LABELS).filter(
    (key) => baseline.bands[key] || variantReport.bands[key],
  );

  return (
    <div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="What to compare">
        {(
          [
            ["bands", "Where the score moved"],
            ["facts", "What a parser recovers"],
            ["documents", "The documents"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={view === key}
            onClick={() => setView(key)}
            className="cursor-pointer rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors"
            style={{
              borderColor: view === key ? "var(--vermilion)" : "var(--line-2)",
              // --cta, not --vermilion. These labels are 12px, and cream on
              // vermilion is 3.55:1 — fine for the large text and graphics that
              // colour is for, and short of the 4.5:1 body text needs. The
              // primary-button pair clears it and matches the button language.
              background: view === key ? "var(--cta)" : "transparent",
              color: view === key ? "var(--on-cta)" : "var(--muted)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {view === "bands" && (
        <div className="mt-5 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-sm">
            <caption className="sr-only">
              Score by band, {baselineLabel} against {variantLabel}
            </caption>
            <thead>
              <tr className="border-border border-b text-left">
                <th className="text-muted py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.1em] uppercase">
                  Band
                </th>
                <th className="text-muted py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.1em] uppercase">
                  {baselineLabel}
                </th>
                <th className="text-muted py-2 pr-4 font-mono text-[10px] font-medium tracking-[0.1em] uppercase">
                  {variantLabel}
                </th>
                <th className="text-muted py-2 font-mono text-[10px] font-medium tracking-[0.1em] uppercase">
                  Change
                </th>
              </tr>
            </thead>
            <tbody>
              {bands.map((key) => {
                const before = baseline.bands[key]?.points ?? 0;
                const after = variantReport.bands[key]?.points ?? 0;
                const delta = Math.round((after - before) * 10) / 10;
                return (
                  <tr key={key} className="border-border border-b">
                    <td className="py-2 pr-4">{BAND_LABELS[key] ?? key}</td>
                    <td className="py-2 pr-4 font-mono tabular-nums">{round(before)}</td>
                    <td className="py-2 pr-4 font-mono tabular-nums">{round(after)}</td>
                    <td
                      className="py-2 font-mono tabular-nums"
                      style={{
                        color:
                          delta > 0 ? "var(--brand)" : delta < 0 ? "#a3271b" : "var(--muted)",
                      }}
                    >
                      {delta > 0 ? `+${round(delta)}` : delta < 0 ? round(delta) : "—"}
                    </td>
                  </tr>
                );
              })}
              <tr>
                <td className="py-2 pr-4 font-semibold">Total</td>
                <td className="py-2 pr-4 font-mono font-semibold tabular-nums">
                  {baseline.score}
                </td>
                <td className="py-2 pr-4 font-mono font-semibold tabular-nums">
                  {variantReport.score}
                </td>
                <td className="py-2 font-mono font-semibold tabular-nums">
                  {variantReport.score > baseline.score
                    ? `+${variantReport.score - baseline.score}`
                    : variantReport.score === baseline.score
                      ? "level"
                      : variantReport.score - baseline.score}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="text-muted mt-3 text-xs leading-relaxed">
            Points, not percentages — each band is worth a fixed share of 100 and the
            weights are published. A band that did not move was already doing what it
            could.
          </p>
        </div>
      )}

      {view === "facts" && (
        <div className="mt-5">
          {variantFidelity && variantFidelity.total ? (
            <>
              <p className="text-sm leading-relaxed">
                We printed the rebuild to a real PDF, read it back with the extractor a
                parser uses, and counted what survived:{" "}
                <b className="font-mono tabular-nums">
                  {variantFidelity.recovered} of {variantFidelity.total}
                </b>{" "}
                facts ({variantFidelity.pct}%).
              </p>
              {variantFidelity.lost.length > 0 ? (
                <div className="border-border mt-4 rounded-lg border p-4">
                  <p className="text-sm font-medium">
                    {variantFidelity.lost.length} it could not read back
                  </p>
                  <ul className="text-muted mt-2 list-disc space-y-1 pl-4 text-sm leading-snug">
                    {variantFidelity.lost.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                  <p className="text-muted mt-3 text-xs leading-relaxed">
                    These are facts we printed that the extractor did not recover. Usually
                    a glyph the font renders as an image, or a string the layout split
                    across a line break. It is a fact about two files, not a judgement.
                  </p>
                </div>
              ) : (
                <p className="mt-4 text-sm">
                  Everything we printed came back out. There is nothing in this document a
                  parser cannot read.
                </p>
              )}
            </>
          ) : (
            <p className="text-muted text-sm">
              No fidelity measurement was recorded for this rebuild.
            </p>
          )}
        </div>
      )}

      {view === "documents" && (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <div>
            <p className="text-muted mb-2 font-mono text-[10px] tracking-[0.12em] uppercase">
              {baselineLabel} — what a parser reads
            </p>
            <pre className="bg-surface-2 border-border h-[28rem] overflow-auto rounded-xl border p-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {originalText || "Nothing could be extracted from this file."}
            </pre>
          </div>
          <div>
            <p className="text-muted mb-2 font-mono text-[10px] tracking-[0.12em] uppercase">
              {variantLabel} — the rebuilt PDF
            </p>
            {/* An iframe rather than a link, so the proof does not leave the
                page. The CSP allows same-origin frames for exactly this; the
                document itself is served by an ownership-checked route. */}
            <iframe
              src={`/api/variants/${variantId}/file#toolbar=0`}
              title={`${variantLabel} rebuild, rendered`}
              className="border-border h-[28rem] w-full rounded-xl border"
              style={{ background: "var(--surface-2)" }}
            />
            <p className="text-muted mt-2 text-xs">
              <a
                href={`/api/variants/${variantId}/file`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand underline"
              >
                Open it full size
              </a>{" "}
              if your browser will not preview a PDF here.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/** One decimal, and no trailing ".0" — band points are rarely fractional. */
function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
