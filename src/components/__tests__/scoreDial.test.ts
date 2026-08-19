import { describe, expect, it } from "vitest";

/**
 * The score dial's geometry.
 *
 * A component that takes a `size` prop has to mean it, and this one did not:
 * the ring was drawn from `size` while the text inside was hard-coded at
 * text-4xl (36px) over an 11px label. That is ~51px of stacked type, which is
 * fine inside the 111px inner diameter of the default 132 on the report page
 * and does not fit the 50px of the size-64 dial the variant cards asked for.
 * The score and the word GRADE rendered on top of each other and the dial read
 * as a smear.
 *
 * These assertions are the arithmetic that fix duplicated, so the next person
 * to change a ratio finds out here rather than in a screenshot. The layout
 * rules are copied from ScoreDial deliberately — a test that imported them
 * would pass for any values at all.
 */

const dial = (size: number) => {
  const stroke = Math.max(3, Math.round(size * 0.053));
  const r = (size - stroke * 2) / 2;
  const scoreSize = Math.round(size * 0.273);
  const gradeSize = Math.max(10, Math.round(size * 0.083));
  const gap = Math.max(2, Math.round(size * 0.03));
  const showsGrade = size >= 72;
  return {
    stroke,
    r,
    scoreSize,
    gradeSize,
    gap,
    showsGrade,
    /** Height of the stacked text. */
    stack: scoreSize + (showsGrade ? gap + gradeSize : 0),
    /** Usable diameter inside the ring. */
    inner: (r - stroke / 2) * 2,
  };
};

/** Width of "GRADE A" — 7 characters plus 6 letter-spacing gaps. */
function labelWidth(size: number): number {
  const { gradeSize } = dial(size);
  const tracking = size >= 100 ? 0.14 : 0.06;
  return 7 * gradeSize * 0.6 + 6 * gradeSize * tracking;
}

/**
 * The circle narrows away from its centre, and the label sits below it — so the
 * width available to the label is a chord, not the diameter. This is what the
 * first attempt at the fix got wrong: a 10px label fits the HEIGHT at size 64
 * and is still wider than the circle at the point it is drawn.
 */
function chordAtLabel(size: number): number {
  const { scoreSize, gap, gradeSize, r, stroke } = dial(size);
  const below = scoreSize / 2 + gap + gradeSize / 2;
  const inner = r - stroke / 2;
  return 2 * Math.sqrt(Math.max(0, inner * inner - below * below));
}

const SIZES_IN_USE = [132, 72];

describe("ScoreDial geometry", () => {
  it("reproduces the original look at the default size", () => {
    // The report page has always been correct. Fixing the small dial must not
    // move it.
    const d = dial(132);
    expect(d.stroke).toBe(7);
    expect(d.r).toBe(59);
    expect(d.scoreSize).toBe(36);
    expect(d.gradeSize).toBe(11);
  });

  it("keeps the text inside the ring at every size the app uses", () => {
    for (const size of SIZES_IN_USE) {
      const d = dial(size);
      expect(d.stack, `stack overflows the ring at ${size}`).toBeLessThan(d.inner);
    }
  });

  it("keeps the grade label inside the circle, not merely inside its height", () => {
    for (const size of SIZES_IN_USE) {
      if (!dial(size).showsGrade) continue;
      expect(labelWidth(size), `"GRADE A" is wider than the circle at ${size}`).toBeLessThan(
        chordAtLabel(size),
      );
    }
  });

  it("drops the grade rather than shrinking it below 10px", () => {
    // An unreadable label is worse than an absent one: it is noise on top of
    // the number that matters. The screen-reader text always carries the grade.
    for (const size of [40, 48, 56, 64]) {
      expect(dial(size).showsGrade, `${size} should not try to draw a grade`).toBe(false);
    }
    expect(dial(72).showsGrade).toBe(true);
  });

  it("never draws a stroke thicker than the radius", () => {
    // A stroke wider than r inverts the ring into a filled blob.
    for (const size of [40, 48, 64, 72, 100, 132, 200]) {
      const d = dial(size);
      expect(d.stroke, `stroke swallows the ring at ${size}`).toBeLessThan(d.r);
    }
  });

  it("scales monotonically, so a bigger dial is never smaller type", () => {
    let previous = 0;
    for (const size of [48, 56, 64, 72, 100, 132, 200]) {
      const { scoreSize } = dial(size);
      expect(scoreSize).toBeGreaterThanOrEqual(previous);
      previous = scoreSize;
    }
  });
});
