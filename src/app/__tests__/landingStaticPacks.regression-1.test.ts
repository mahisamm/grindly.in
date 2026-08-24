import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("landing-page company snapshot", () => {
  it("uses the committed disclaimer without referencing the removed agent result", () => {
    // Regression: ISSUE-002 — the homepage crashed with `packs is not defined`
    // after company packs moved from an agent call to a committed snapshot.
    // Found by launch QA on 2026-08-25.
    const source = fs.readFileSync(path.join(__dirname, "..", "page.tsx"), "utf8");

    expect(source).toContain("COMPANY_DISCLAIMER");
    expect(source).not.toMatch(/\bpacks\s*\./);
  });
});
