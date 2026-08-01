import { describe, expect, it } from "vitest";
import fs from "node:fs";

const source = fs.readFileSync(new URL("./supportAI.ts", import.meta.url), "utf8");

/**
 * The support bot answers from a hand-written knowledge base, so it is the one
 * place in the product that can be confidently wrong at scale — it will state
 * whatever this file says, in its own words, to every student who asks.
 *
 * It used to tell students they press Submit themselves on LinkedIn, Naukri,
 * Unstop and Indeed. Those four boards were removed from the product after
 * producing zero listings, so that answer described a workflow that no longer
 * exists — sending students to look for a screen that isn't there.
 */
describe("support knowledge base matches what the product does", () => {
  it("leads with the path that needs nothing connected", () => {
    expect(source).toContain("company's OWN careers page");
    expect(source).toContain("needs nothing connected");
  });

  it("says Internshala is optional, because setup no longer asks for it", () => {
    expect(source).toContain("CONNECTING INTERNSHALA IS OPTIONAL");
    expect(source).toContain("fully hands-off without it");
  });

  it("tells the bot the four removed boards are unsupported", () => {
    // Named explicitly rather than omitted: students still ask about them, and
    // silence would let the model improvise an answer.
    expect(source).toContain("LinkedIn, Naukri, Unstop and Indeed are NOT supported");
  });

  it("never promises a prepared-for-you-to-submit queue for those boards", () => {
    expect(source).not.toContain("hands over a ready-to-submit link");
    expect(source).not.toContain("the Submit click stays theirs");
  });

  it("keeps the never-invent-a-fact contract", () => {
    expect(source).toContain("invent a fact about the student");
    expect(source).toContain("handed back to them instead of being sent with a guess");
  });
});
