import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const script = fs.readFileSync(path.join(__dirname, "..", "reset-db.mjs"), "utf8");

describe("reset-db runtime file coverage regression", () => {
  it.each([
    "resumes",
    "resume_tex",
    "resume_variants",
    "screenshots",
    "browser_profile",
    "logs",
    "email-outbox.jsonl",
    "slack-outbox.jsonl",
  ])("clears %s", (runtimePath) => {
    expect(script).toContain(`"${runtimePath}"`);
  });

  it("validates every deletion remains inside the workspace", () => {
    expect(script).toContain("assertWorkspaceTarget(target)");
    expect(script).toContain("resolved === root");
    expect(script).toContain("resolved.startsWith(root + path.sep)");
  });
});
