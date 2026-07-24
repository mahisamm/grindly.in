import { describe, expect, it } from "vitest";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./supportAI.ts", import.meta.url), "utf8");

describe("support auto-apply contract regression", () => {
  it("describes consented Internshala as a staged submit path", () => {
    expect(source).toContain("the staged beta can also submit on Internshala");
  });

  it("keeps hostile account platforms on user-final-submit", () => {
    expect(source).toContain("LinkedIn, Naukri, Unstop or Indeed");
    expect(source).not.toContain("LinkedIn, Internshala, Naukri, Unstop or Indeed");
  });
});
