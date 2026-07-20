import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// The non-negotiable rule (see the plan + fillEngine.js header): the extension
// fills fields but NEVER performs the final submit — no programmatic click, no
// form.submit(), no requestSubmit(). This is what keeps it in the same category
// as a password manager rather than a bot. Enforced mechanically here so it can't
// regress unnoticed in a later edit.
const EXT = path.resolve(__dirname, "..");
const SCRIPTS = ["fillEngine.js", "content/filler.js", "content/bridge.js", "background.js"];

// Strip comments before scanning — we're asserting about executable CODE, not the
// prose that documents it (a doc comment saying "there is no .click() here" must
// not trip the guard). Simple block/line strip; adequate for our own source.
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Interactions that would advance/submit the form on the user's behalf.
const FORBIDDEN = [
  /\.click\s*\(/,
  /\.submit\s*\(/,
  /\.requestSubmit\s*\(/,
  /dispatchEvent\s*\(\s*new\s+(Mouse|Pointer)Event/,
  /dispatchEvent\s*\(\s*new\s+KeyboardEvent[^)]*Enter/,
];

describe("extension never submits on the user's behalf", () => {
  for (const rel of SCRIPTS) {
    it(`${rel} contains no submit/click interaction`, () => {
      const src = codeOnly(fs.readFileSync(path.join(EXT, rel), "utf8"));
      for (const re of FORBIDDEN) {
        expect(re.test(src), `${rel} must not match ${re}`).toBe(false);
      }
    });
  }

  it("filler only dispatches input/change events (framework-safe typing), nothing else", () => {
    const src = fs.readFileSync(path.join(EXT, "fillEngine.js"), "utf8");
    const events = [...src.matchAll(/new Event\(\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(events.sort()).toEqual(["change", "input"]);
  });
});
