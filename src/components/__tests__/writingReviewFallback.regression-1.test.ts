import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("writing review fallback", () => {
  it("separates an optional model outage from the ATS report", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "app", "app", "[id]", "Workspace.tsx"),
      "utf8",
    );
    expect(source).toContain("Optional writing feedback is temporarily unavailable.");
    expect(source).toContain("Your ATS score");
    expect(source).toContain("and resume are unaffected.");
    expect(source).toContain("Retry review");
    expect(source).not.toContain("notes on the writing did not arrive");
  });
});
