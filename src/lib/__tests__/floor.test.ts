import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SHIPPABLE_FLOOR } from "@/lib/reportTypes";

/**
 * The floor is written down twice — once in Python where it is enforced, once
 * in TypeScript where it is rendered — because the browser needs the number to
 * draw a static page and a subprocess round trip to learn "80" is a worse
 * trade than a test.
 *
 * This is the test that makes the duplication safe. Without it the two drift,
 * and the failure is invisible in the worst possible way: the agent ships a
 * variant it considers acceptable while the card beside it says the variant is
 * under the bar, or the reverse.
 */
describe("the shippable floor", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "agent", "readiness.py"),
    "utf8",
  );

  it("matches agent/readiness.py", () => {
    const match = source.match(/^SHIPPABLE_FLOOR\s*=\s*(\d+)\s*$/m);
    expect(match, "SHIPPABLE_FLOOR is not defined in agent/readiness.py").not.toBeNull();
    expect(Number(match![1])).toBe(SHIPPABLE_FLOOR);
  });

  it("sits above what the mechanical bands alone can earn", () => {
    // readable + fields + structure are properties of our own template, not of
    // the candidate's career. With coverage redistributed across the four
    // remaining bands they come to 76.5 of 100 when all three are perfect. A
    // floor at or below that would be cleared by an empty resume rendered
    // cleanly, which is exactly the promise this number must not make.
    const weights = { readable: 30, fields: 20, structure: 15, impact: 20, coverage: 15 };
    const rest = weights.readable + weights.fields + weights.structure + weights.impact;
    const scale = (w: number) => w + weights.coverage * (w / rest);
    const mechanical =
      scale(weights.readable) + scale(weights.fields) + scale(weights.structure);

    expect(mechanical).toBeLessThan(SHIPPABLE_FLOOR);
    // …and not so far above it that a good resume cannot reach it.
    expect(SHIPPABLE_FLOOR).toBeLessThan(mechanical + scale(weights.impact) * 0.5);
  });
});
