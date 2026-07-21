import { describe, it, expect } from "vitest";
import { computeFunnel, overallConversion, formatPct } from "@/lib/funnel";

const steps = [
  { label: "Visitors", value: 1000 },
  { label: "Signups", value: 200 },
  { label: "Approved", value: 150 },
  { label: "Paying", value: 30 },
];

describe("computeFunnel", () => {
  it("computes share-of-top for each step", () => {
    const rows = computeFunnel(steps);
    expect(rows[0].pctOfTop).toBe(1);
    expect(rows[1].pctOfTop).toBeCloseTo(0.2);
    expect(rows[3].pctOfTop).toBeCloseTo(0.03);
  });

  it("computes step-to-step conversion", () => {
    const rows = computeFunnel(steps);
    expect(rows[0].stepConversion).toBe(1);
    expect(rows[1].stepConversion).toBeCloseTo(0.2); // 200/1000
    expect(rows[2].stepConversion).toBeCloseTo(0.75); // 150/200
    expect(rows[3].stepConversion).toBeCloseTo(0.2); // 30/150
  });

  it("computes drop-off counts", () => {
    const rows = computeFunnel(steps);
    expect(rows[0].dropOff).toBe(0);
    expect(rows[1].dropOff).toBe(800);
    expect(rows[2].dropOff).toBe(50);
    expect(rows[3].dropOff).toBe(120);
  });

  it("never divides by zero on an empty top step", () => {
    const rows = computeFunnel([
      { label: "A", value: 0 },
      { label: "B", value: 0 },
    ]);
    expect(rows[0].pctOfTop).toBe(0);
    expect(rows[1].stepConversion).toBe(0);
  });

  it("floors negative / non-finite counts to zero", () => {
    const rows = computeFunnel([
      { label: "A", value: 100 },
      { label: "B", value: -5 },
      { label: "C", value: NaN },
    ]);
    expect(rows[1].value).toBe(0);
    expect(rows[2].value).toBe(0);
    expect(rows[1].dropOff).toBe(100);
  });
});

describe("overallConversion", () => {
  it("is last / first", () => {
    expect(overallConversion(steps)).toBeCloseTo(0.03);
  });
  it("handles trivial inputs", () => {
    expect(overallConversion([])).toBe(0);
    expect(overallConversion([{ label: "A", value: 5 }])).toBe(1);
  });
});

describe("formatPct", () => {
  it("formats ratios as percentages", () => {
    expect(formatPct(0.1234)).toBe("12.3%");
    expect(formatPct(1)).toBe("100.0%");
    expect(formatPct(0.5, 0)).toBe("50%");
  });
});
