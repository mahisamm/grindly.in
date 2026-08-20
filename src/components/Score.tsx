"use client";

import { useEffect, useState } from "react";
import type { Band, Fidelity, Finding, Report } from "@/lib/reportTypes";
import { BAND_BLURBS, BAND_LABELS, scoreColor } from "@/lib/reportTypes";

/**
 * The readiness report, rendered.
 *
 * Two rules drive every choice in here.
 *
 * The number is never shown alone. A bare "71/100" is exactly the unfalsifiable
 * ATS score the whole product exists to replace, so the score always appears
 * beside the bands that produced it and the findings that explain them. If a
 * user cannot click from the number to the sentence that caused it, we have
 * shipped the thing we set out to fix.
 *
 * Severity is encoded in form as well as colour — a label and a left rule, not
 * just a red tint. Roughly one in twelve men has a colour vision deficiency, and
 * "the red ones are urgent" is not an instruction they can follow.
 */

export function ScoreDial({
  score,
  grade,
  size = 132,
  animate = false,
}: {
  score: number;
  grade: string;
  size?: number;
  /** Count the number up and draw the ring on mount — the workspace's first
      reveal only. Everywhere else the dial is a fact, not an event. */
  animate?: boolean;
}) {
  // 0..1 through the entrance. Starts complete unless animating, so the
  // default renders exactly what it always did, with no effect and no flicker.
  const [progress, setProgress] = useState(animate ? 0 : 1);
  useEffect(() => {
    if (!animate) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const id = requestAnimationFrame(() => setProgress(1));
      return () => cancelAnimationFrame(id);
    }
    const t0 = performance.now();
    const DURATION = 900;
    let raf = requestAnimationFrame(function tick(now: number) {
      const p = Math.min(1, (now - t0) / DURATION);
      // easeOutCubic: fast through the small numbers, settling on the real one
      // — a linear count spends most of its time on digits nobody cares about.
      setProgress(1 - Math.pow(1 - p, 3));
      if (p < 1) raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [animate]);
  // EVERYTHING scales with `size`, and that is the bug this shape fixes.
  //
  // The ring was drawn from `size` while the text inside it was hard-coded at
  // text-4xl over an 11px label — about 53px of stacked type. Correct at the
  // default 132 on the report page, and overflowing at the 64 the variant cards
  // ask for, where the inner diameter is 50px: the score and the word GRADE
  // rendered on top of each other and the whole dial read as a smear.
  //
  // A component that takes a size prop has to mean it. The ratios below are
  // pinned to reproduce the previous look exactly at 132 (stroke 7, radius 59,
  // 36px score, 11px label), so the screen this was always right on does not
  // move.
  const stroke = Math.max(3, Math.round(size * 0.053));
  const r = (size - stroke * 2) / 2;
  const circumference = 2 * Math.PI * r;
  // Ring and number share `progress`, so they arrive together. The stroke
  // colour is the FINAL score's from the first frame — counting up through
  // red and amber on the way to a green 91 would flash two verdicts that
  // were never given.
  const filled = (Math.max(0, Math.min(100, score)) / 100) * progress;
  const shownScore = Math.round(score * progress);

  const scoreSize = Math.round(size * 0.273);
  // 10px floor. Below that the label stops being readable, and an unreadable
  // label is worse than an absent one — it is visual noise sitting on top of
  // the number that matters.
  const gradeSize = Math.max(10, Math.round(size * 0.083));
  // Letter-spacing is a fixed em value, so it costs proportionally more width
  // the smaller the type gets. "GRADE A" at 0.14em inside a 50px circle does
  // not fit; at 0.06em it does.
  const gradeTracking = size >= 100 ? "0.14em" : "0.06em";

  return (
    <div
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={scoreColor(score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${circumference * filled} ${circumference}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span
          className="font-display font-bold tabular-nums"
          style={{ fontSize: scoreSize, lineHeight: 1 }}
        >
          {shownScore}
        </span>
        {/* 72px is where "GRADE A" physically fits, not a guess: at a 10px
            floor the label is ~46px wide, and the chord of the circle at the
            height it sits is 49px at size 72 and only 45px at 64. Below the
            threshold the grade is dropped rather than shrunk — an unreadable
            label is worse than an absent one, and the ring's colour already
            carries the same signal. The screen reader text below always has
            it. */}
        {size >= 72 && grade && (
          <span
            className="text-muted uppercase"
            style={{
              fontSize: gradeSize,
              letterSpacing: gradeTracking,
              lineHeight: 1,
              marginTop: Math.max(2, Math.round(size * 0.03)),
            }}
          >
            Grade {grade}
          </span>
        )}
      </div>
      <span className="sr-only">Readiness score {score} out of 100, grade {grade}.</span>
    </div>
  );
}

export function BandBars({
  bands,
  animate = false,
}: {
  bands: Record<string, Band>;
  /** Grow the bars from zero on mount — see ScoreDial. */
  animate?: boolean;
}) {
  // Mount at zero width, then let the transition already on the fill carry
  // each bar to its real value. Two frames, not one: a single frame collapses
  // the two widths into one style write and nothing moves.
  const [grown, setGrown] = useState(!animate);
  useEffect(() => {
    if (!animate) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  const entries = Object.entries(bands);
  if (!entries.length) return null;

  return (
    <ul className="flex flex-col gap-3">
      {entries.map(([key, band]) => (
        <li key={key}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{BAND_LABELS[key] ?? key}</span>
            <span className="text-muted font-mono text-xs tabular-nums">
              {band.score}
              <span className="opacity-50"> / 100</span>
            </span>
          </div>
          <div className="bg-surface-2 mt-1.5 h-2 w-full overflow-hidden rounded-full">
            <div
              className="h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
              style={{
                width: grown ? `${band.score}%` : "0%",
                background: scoreColor(band.score),
              }}
            />
          </div>
          <p className="text-muted mt-1 text-xs leading-snug">{BAND_BLURBS[key]}</p>
        </li>
      ))}
    </ul>
  );
}

export function Findings({ findings }: { findings: Finding[] }) {
  if (!findings.length) {
    return (
      <p className="text-muted text-sm">
        Nothing we can detect is wrong with this resume. That is not the same as
        nothing being wrong — it means every mechanical check passed.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {findings.map((f, i) => (
        <li
          key={`${f.band}-${i}`}
          className="bg-surface border-border rounded-lg border p-4"
          style={{
            borderLeftWidth: 3,
            borderLeftColor: f.severity === "critical" ? "var(--danger)" : "var(--warn)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 font-mono text-[10px] tracking-[0.1em] uppercase"
              style={{
                background: f.severity === "critical" ? "var(--danger)" : "var(--warn)",
                color: "var(--paper)",
              }}
            >
              {f.severity === "critical" ? "Blocks you" : "Costs you"}
            </span>
            <span className="text-muted font-mono text-[10px] tracking-[0.1em] uppercase">
              {BAND_LABELS[f.band] ?? f.band}
            </span>
          </div>
          <p className="mt-2 text-sm font-medium">{f.problem}</p>
          <p className="text-muted mt-1 text-sm leading-relaxed">{f.fix}</p>
        </li>
      ))}
    </ul>
  );
}

/**
 * The measured claim, in one sentence.
 *
 * This is the only headline the product is allowed to make, and it is a fact
 * about two files: we rendered a PDF, read it back with the extractor a parser
 * uses, and counted what came out.
 */
export function FidelityLine({
  fidelity,
}: {
  fidelity: Fidelity | null;
}) {
  if (!fidelity || !fidelity.total) return null;
  return (
    <div className="border-border bg-surface-2 rounded-lg border p-4">
      <p className="text-sm">
        A parser recovered{" "}
        <b className="font-mono tabular-nums">
          {fidelity.recovered} of {fidelity.total}
        </b>{" "}
        facts from this PDF ({fidelity.pct}%).
      </p>
      {fidelity.lost.length > 0 && (
        <details className="mt-2">
          <summary className="text-muted cursor-pointer text-xs">
            {fidelity.lost.length} it could not read
          </summary>
          <ul className="text-muted mt-2 list-disc space-y-1 pl-4 text-xs">
            {fidelity.lost.slice(0, 8).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function ReportPanel({ report, animate = false }: { report: Report; animate?: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      {/* items-start, not items-center.
          Centred, the dial sits halfway down a four-bar stack that is much
          taller than it is, so on a tablet it floated in the middle of an empty
          left column with the bars starting well below its top edge. Aligned to
          the top, the score and the first band share a line and the block reads
          as one object. Below `sm` the dial goes above the bars entirely —
          side by side at 390px leaves the bars about 180px wide. */}
      <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-start sm:gap-6">
        <ScoreDial score={report.score} grade={report.grade} animate={animate} />
        <div className="w-full min-w-0 flex-1">
          <BandBars bands={report.bands} animate={animate} />
        </div>
      </div>
      <div>
        {/* h2, not h3. The page heading is the resume's name (h1) and this is
            the next level down; an h3 here made a screen reader announce a
            level-two heading that does not exist. */}
        <h2 className="font-display mb-3 text-lg font-semibold">
          {report.findings.length === 0
            ? "Nothing found"
            : `${report.findings.length} thing${report.findings.length === 1 ? "" : "s"} to fix`}
        </h2>
        <Findings findings={report.findings} />
      </div>
    </div>
  );
}
