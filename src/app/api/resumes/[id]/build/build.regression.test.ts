import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("manual resume builds", () => {
  it("keep the uploaded source record immutable", () => {
    const source = fs.readFileSync(path.join(__dirname, "route.ts"), "utf8");

    // A build is stored as a Variant. Replacing resume.text here made a partial
    // editor extraction become the user's primary uploaded resume.
    expect(source).toContain('label: OWN_EDIT_LABEL');
    expect(source).not.toContain("structToText(struct)");
    expect(source).not.toContain("build-resume-update-failed");
  });
});
