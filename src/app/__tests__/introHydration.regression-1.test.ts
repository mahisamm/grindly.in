import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("pre-paint document attributes", () => {
  it("accepts the inline theme and intro attributes during hydration", () => {
    // Regression: ISSUE-005 — the pre-paint script correctly adds data-intro,
    // but React warned and could rebuild the boundary because the server-side
    // <html> did not carry the client-only attribute.
    const source = fs.readFileSync(path.join(__dirname, "..", "layout.tsx"), "utf8");

    expect(source).toContain("suppressHydrationWarning");
    expect(source).toContain("setAttribute('data-intro','1')");
  });
});
