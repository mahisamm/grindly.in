/**
 * Conversion-funnel math. The admin dashboard already collects the step counts
 * (visitors → signups → approved → paying); this turns raw counts into the
 * numbers an analyst actually reads: each step's share of the top, its
 * conversion from the *previous* step, and the absolute drop-off. Pure and
 * tested so the dashboard just renders — no analytics logic living in JSX.
 */

export type FunnelStep = { label: string; value: number };

export type FunnelRow = FunnelStep & {
  /** value / top step, 0..1 — the bar width. */
  pctOfTop: number;
  /** value / previous step, 0..1 — the step-to-step conversion (1 for the first). */
  stepConversion: number;
  /** previous.value - value — people lost at this step (0 for the first). */
  dropOff: number;
};

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

/**
 * Annotate each step with share-of-top, step conversion, and drop-off.
 * Negative/NaN inputs are floored to 0 so a bad count can't produce a bar
 * wider than 100% or a nonsense rate.
 */
export function computeFunnel(steps: FunnelStep[]): FunnelRow[] {
  const clean = steps.map((s) => ({
    label: s.label,
    value: Number.isFinite(s.value) && s.value > 0 ? s.value : 0,
  }));
  const top = clean[0]?.value ?? 0;
  return clean.map((step, i) => {
    const prev = i === 0 ? step.value : clean[i - 1].value;
    return {
      ...step,
      pctOfTop: ratio(step.value, top),
      stepConversion: i === 0 ? 1 : ratio(step.value, prev),
      dropOff: i === 0 ? 0 : Math.max(0, prev - step.value),
    };
  });
}

/** End-to-end conversion: last step / first step, 0..1. */
export function overallConversion(steps: FunnelStep[]): number {
  if (steps.length < 2) return steps.length === 1 ? 1 : 0;
  return ratio(steps[steps.length - 1].value, steps[0].value);
}

/** Format a 0..1 ratio as a percent string, e.g. 0.1234 → "12.3%". */
export function formatPct(ratio01: number, digits = 1): string {
  return `${(ratio01 * 100).toFixed(digits)}%`;
}
