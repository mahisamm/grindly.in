import { describe, expect, it } from "vitest";
import { toRgb } from "@/components/ParticleField";

const FALLBACK: [number, number, number] = [1, 2, 3];

describe("toRgb", () => {
  it("reads the six-digit hex the palette actually uses", () => {
    expect(toRgb("#17140f", FALLBACK)).toEqual([23, 20, 15]);
    expect(toRgb("#e3402a", FALLBACK)).toEqual([227, 64, 42]);
  });

  it("tolerates the leading space getComputedStyle returns", () => {
    // `getComputedStyle(el).getPropertyValue("--ink")` yields " #17140f", with
    // the space the author put after the colon. Every read in this component
    // goes through that call.
    expect(toRgb(" #17140f", FALLBACK)).toEqual([23, 20, 15]);
    expect(toRgb("  #FFF  ", FALLBACK)).toEqual([255, 255, 255]);
  });

  it("expands three-digit hex", () => {
    expect(toRgb("#abc", FALLBACK)).toEqual([170, 187, 204]);
  });

  it("reads the functional notations too", () => {
    expect(toRgb("rgb(23, 20, 15)", FALLBACK)).toEqual([23, 20, 15]);
    expect(toRgb("rgb(23 20 15 / 0.5)", FALLBACK)).toEqual([23, 20, 15]);
  });

  it("falls back rather than drawing in NaN", () => {
    // A palette rewritten in oklch or color-mix reaches here as something this
    // cannot parse. The field must keep drawing in a real colour: `rgba(NaN,
    // ...)` is an invalid fillStyle, which canvas ignores silently, leaving the
    // previous colour on every speck.
    expect(toRgb("oklch(0.2 0.02 60)", FALLBACK)).toEqual(FALLBACK);
    expect(toRgb("", FALLBACK)).toEqual(FALLBACK);
    expect(toRgb("var(--something-else)", FALLBACK)).toEqual(FALLBACK);
  });
});
