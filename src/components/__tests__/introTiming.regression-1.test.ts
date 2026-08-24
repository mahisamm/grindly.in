import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("first-visit intro timing", () => {
  it("reveals the landing CTA in under 1.5 seconds", () => {
    // Regression: FINDING-002 — the original 1,700ms hold plus 950ms curtain
    // made a first visitor wait about 2.65 seconds before seeing the product.
    const source = fs.readFileSync(path.join(__dirname, "..", "IntroSplash.tsx"), "utf8");
    const lift = Number(source.match(/setPhase\("out"\),\s*(\d+)/)?.[1]);
    const removal = Number(source.match(/setPhase\("hidden"\);\s*\n\s*},\s*(\d+)/)?.[1]);

    // Leave headroom for hydration so real browser time remains below 1.5s.
    expect(lift).toBeLessThanOrEqual(650);
    expect(removal).toBeLessThanOrEqual(450);
    expect(lift + removal).toBeLessThanOrEqual(1100);
  });
});
