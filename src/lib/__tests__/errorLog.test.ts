import { describe, it, expect } from "vitest";
import { fingerprint } from "@/lib/errorLog";

/**
 * Crashes are stored grouped, not appended. One exception inside a retry loop
 * fires hundreds of times a minute, and a row per occurrence is a table nobody
 * can read — so what counts as "the same bug" is the whole design, and it has
 * to mean the same thing on both sides of the system.
 */
describe("crash fingerprints", () => {
  it("groups the same fault from the same place", () => {
    const a = fingerprint("worker", "TimeoutError", "page.goto timed out");
    const b = fingerprint("worker", "TimeoutError", "page.goto timed out");
    expect(a).toBe(b);
  });

  it("keeps the worker's crash separate from the browser's", () => {
    // Same words, different half of the product, different fix.
    const worker = fingerprint("worker", "TypeError", "x is not a function");
    const browser = fingerprint("browser", "TypeError", "x is not a function");
    expect(worker).not.toBe(browser);
  });

  it("separates two different faults of the same class", () => {
    expect(fingerprint("web", "Error", "no session")).not.toBe(
      fingerprint("web", "Error", "no resume"),
    );
  });

  it("matches the python writer's rule exactly", () => {
    // agent/error_log.fingerprint is sha1 of source\nkind\nmessage. The two
    // processes write to ONE table; disagreeing here would file the same fault
    // twice and make every count wrong.
    // sha1("worker\nValueError\nboom")
    expect(fingerprint("worker", "ValueError", "boom")).toBe(
      "a74e286e3ab68bdaabeed6919347886cb7f466ba",
    );
  });
});
