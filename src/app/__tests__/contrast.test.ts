import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The contrast the design system claims, measured.
 *
 * globals.css states specific ratios in its comments — "4.83:1 on paper",
 * "5.26:1 on panel" — and until now nothing checked them. Adding a dark theme
 * is exactly the change that breaks a claim like that silently, because
 * contrast is a property of a PAIR and a theme redefines one half of every
 * pair at once.
 *
 * It found a real failure on the way in. Most coloured fills here flip
 * lightness between themes — vermilion, danger and warn all become light on the
 * dark ground — so `--paper` flips with them and stays readable. `--cta` does
 * not flip: a primary button is deep red in both themes. So `color: var(--paper)`
 * on it went from cream-on-red at 4.8:1 to near-black-on-red at 2.9:1, on the
 * most-used control in the product. That is what `--on-cta` exists for.
 */

const CSS = fs.readFileSync(
  path.join(__dirname, "..", "globals.css"),
  "utf8",
);

/**
 * Pull `--token: value;` pairs out of a block of CSS.
 *
 * Values are captured raw, because half of them are indirections —
 * `--background: var(--paper)` — and resolving has to happen after the whole
 * palette is read, not while reading it.
 */
function readTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([\w-]+)\s*:\s*([^;}]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/** Follow `var(--x)` chains down to the hex the browser would actually paint. */
function resolve(tokens: Record<string, string>, name: string, seen = new Set<string>()): string {
  const value = tokens[name];
  if (!value) throw new Error(`--${name} is not defined in this palette`);
  const ref = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (!ref) return value;
  if (seen.has(name)) throw new Error(`--${name} resolves in a circle`);
  seen.add(name);
  return resolve(tokens, ref[1], seen);
}

/** The block starting at `selector`, up to its closing brace. */
function block(selector: string): string {
  const start = CSS.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block in globals.css`);
  const open = CSS.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    if (CSS[i] === "}") {
      depth--;
      if (depth === 0) return CSS.slice(open, i);
    }
  }
  throw new Error(`unterminated ${selector} block`);
}

const light = readTokens(block(":root {"));
// The explicit dark choice. Its values are the same as the prefers-color-scheme
// block by construction — see the note in globals.css.
const dark = { ...light, ...readTokens(block(':root[data-theme="dark"]')) };

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.slice(0, 6);
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** [text, background, what it is] — every pair the product actually renders. */
const PAIRS: [string, string, string][] = [
  ["foreground", "background", "body text on the page"],
  ["muted", "background", "secondary text on the page"],
  ["muted", "surface", "secondary text on a card"],
  ["brand", "background", "links and scores on the page"],
  ["brand", "surface", "links and scores on a card"],
  ["on-cta", "cta", "the primary button label"],
  ["paper", "danger", "text on a critical chip"],
  ["paper", "warn", "text on a warning chip"],
  ["paper", "brand", "the score chip on the resume list"],
];

describe.each([
  ["light", light],
  ["dark", dark],
])("contrast in the %s theme", (themeName, tokens) => {
  it("resolves every token the pairs below reference to a real colour", () => {
    for (const [fg, bg] of PAIRS) {
      for (const token of [fg, bg]) {
        expect(
          resolve(tokens, token),
          `--${token} does not resolve to a hex in the ${themeName} palette`,
        ).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      }
    }
  });

  it.each(PAIRS)("%s on %s (%s) clears 4.5:1", (fg, bg, what) => {
    const measured = ratio(resolve(tokens, fg), resolve(tokens, bg));
    expect(
      measured,
      `${what}: --${fg} ${tokens[fg]} on --${bg} ${tokens[bg]} is ${measured.toFixed(2)}:1 in the ${themeName} theme`,
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the identity colour", () => {
  it("clears the 3:1 that large text and graphics need, in both themes", () => {
    // --vermilion is deliberately NOT held to 4.5:1 — globals.css explains the
    // split at length: it is the hero accent, the washes and the rules, and
    // everything set at reading size uses --brand or --cta instead. Cream on it
    // is 3.55:1.
    //
    // Keeping it OUT of the 4.5:1 list is a claim about the product, not a
    // lowered bar: it means no small text is drawn on a vermilion fill. Three
    // selected-pill controls broke that rule with 12px labels and were moved to
    // --cta when this test was written.
    for (const [name, tokens] of [["light", light], ["dark", dark]] as const) {
      const measured = ratio(resolve(tokens, "vermilion"), resolve(tokens, "background"));
      expect(measured, `--vermilion on the ${name} ground is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
    }
  });
});
