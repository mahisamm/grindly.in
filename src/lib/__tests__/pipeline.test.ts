import { describe, it, expect } from "vitest";
import { dueNow, visibleToUser, kitEligible } from "@/lib/pipeline";

const NOW = new Date("2026-07-20T12:00:00Z");

describe("dueNow — gates approve/approve-all: matched-only, on purpose", () => {
  it("is status:matched with the embargo OR clause", () => {
    expect(dueNow(NOW)).toEqual({
      status: "matched",
      OR: [{ scheduledFor: null }, { scheduledFor: { lte: NOW } }],
    });
  });
});

describe("kitEligible — what the Apply Kit (dashboard + extension) may serve", () => {
  it("includes a due matched row via the first OR branch", () => {
    const w = kitEligible(NOW);
    expect(w.OR).toContainEqual({ status: "matched", OR: [{ scheduledFor: null }, { scheduledFor: { lte: NOW } }] });
  });

  it("includes EVERY approved row, unconditionally — the regression this exists to prevent", () => {
    // An approved row is exactly "the user clicked Open & submit" — the moment
    // the kit is most useful. It must never be excluded by a schedule check.
    const w = kitEligible(NOW);
    expect(w.OR).toContainEqual({ status: "approved" });
  });

  it("does not include applied/failed/skipped rows", () => {
    const w = kitEligible(NOW) as { OR: Record<string, unknown>[] };
    const statuses = w.OR.map((c) => c.status);
    expect(statuses).not.toContain("applied");
    expect(statuses).not.toContain("failed");
    expect(statuses).not.toContain("skipped");
  });
});

describe("visibleToUser — approved rows are always visible regardless of scheduledFor", () => {
  it("never embargoes a non-matched row", () => {
    const w = visibleToUser("u1", NOW);
    expect(w.OR).toContainEqual({ status: { not: "matched" } });
  });
});
