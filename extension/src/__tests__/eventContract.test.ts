/**
 * The extension and the server must agree on the words they use.
 *
 * They are two codebases in two languages that only ever meet over HTTP, and
 * nothing in either one fails loudly when they drift. The executor reported
 * `blocked` for a form it could not answer honestly; the server's transition
 * table has no such event, so it answered 400 and the report was thrown away.
 * The visible result was the opposite of a crash: the task stayed in `filling`,
 * its lease ran out ten minutes later, the reaper put it back in the queue, and
 * autopilot opened the same unanswerable form again. Forever.
 *
 * A unit test on either side alone passes happily through that. So this reads
 * both files and checks the vocabulary matches.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const EXEC = fs.readFileSync(
  path.join(ROOT, "extension", "src", "content", "executor.js"), "utf8");
const GATE = fs.readFileSync(
  path.join(ROOT, "extension", "src", "humanGate.js"), "utf8");
const ROUTE = fs.readFileSync(
  path.join(ROOT, "src", "app", "api", "extension", "tasks", "[id]", "event", "route.ts"), "utf8");

/** The keys of an object literal declared as `const NAME ... = { ... }`. */
function objectKeys(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name}`);
  expect(start, `${name} not found — did it get renamed?`).toBeGreaterThan(-1);
  const open = src.indexOf("{", start);
  const close = src.indexOf("};", open);
  return [...src.slice(open, close).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

/** The strings of a `new Set([...])` declared as `const NAME = new Set([...])`. */
function setMembers(src: string, name: string): string[] {
  const start = src.indexOf(`const ${name}`);
  expect(start, `${name} not found — did it get renamed?`).toBeGreaterThan(-1);
  const open = src.indexOf("[", start);
  const close = src.indexOf("]", open);
  return [...src.slice(open, close).matchAll(/["'](\w+)["']/g)].map((m) => m[1]);
}

const ACCEPTED_EVENTS = objectKeys(ROUTE, "TRANSITIONS");
const ACCEPTED_GATES = setMembers(ROUTE, "GATES");

describe("the executor only speaks words the server knows", () => {
  it("parsed the server's tables at all", () => {
    // If the shape of route.ts changes and these come back empty, every
    // assertion below would pass vacuously — which is how a contract test
    // quietly stops being one.
    expect(ACCEPTED_EVENTS).toContain("submitted");
    expect(ACCEPTED_EVENTS).toContain("awaiting_human");
    expect(ACCEPTED_GATES).toContain("captcha");
  });

  it("sends no event the transition table would reject", () => {
    const sent = [...EXEC.matchAll(/\breport\(\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(4);
    for (const event of new Set(sent)) {
      expect(ACCEPTED_EVENTS, `executor reports "${event}"`).toContain(event);
    }
  });

  it("sends no literal gate reason the server would collapse to a shrug", () => {
    // An unrecognised reason is not rejected — it silently becomes
    // "unknown_question". That is safe but it destroys the diagnosis, and the
    // released-slot decision is made from the collapsed value, so a typo here
    // changes whether the user gets their daily slot back.
    const reasons = [...EXEC.matchAll(/reason:\s*["'](\w+)["']/g)].map((m) => m[1]);
    const gateReasons = reasons.filter((r) => r !== "fill_error"); // `failed`, not a gate
    expect(gateReasons.length).toBeGreaterThan(0);
    for (const reason of new Set(gateReasons)) {
      expect(ACCEPTED_GATES, `executor reports gate "${reason}"`).toContain(reason);
    }
  });

  it("every gate humanGate can detect is one the server stores", () => {
    // These are passed straight through as `reason: gate`, so a new detector
    // with a new label lands in the database as "unknown_question" and the
    // reason a real application stopped becomes unknowable.
    const detected = [...GATE.matchAll(/reason:\s*["'](\w+)["']/g)].map((m) => m[1]);
    expect(detected.length).toBeGreaterThan(3);
    for (const reason of new Set(detected)) {
      expect(ACCEPTED_GATES, `humanGate detects "${reason}"`).toContain(reason);
    }
  });
});

describe("nobody is watching this tab", () => {
  // Autopilot creates its tabs with `active: false`. Chrome clamps chained
  // timers in a hidden tab to one per second, and to one per MINUTE once it has
  // been hidden five minutes. Waits that count their intended delay rather than
  // elapsed time turn into twenty-minute hangs there, while the heartbeat keeps
  // renewing the lease — so the task never ends and autopilot wedges.

  it("counts elapsed time, not the delay it asked for", () => {
    // Comments stripped first: the header explains this bug by quoting the code
    // that caused it, and a guard that trips on its own documentation is a
    // guard nobody can write the explanation for.
    const code = EXEC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/waited \+= \d+/);
    expect(code).toMatch(/Date\.now\(\)/);
  });

  it("waits on DOM changes, which throttling does not touch", () => {
    expect(EXEC).toMatch(/new MutationObserver/);
  });

  it("bounds the whole run inside the server's lease", () => {
    // LEASE_MS is ten minutes. A run that outlives it holds the single task
    // slot until the reaper takes it back, and the user sees "Working on an
    // application…" with nothing behind it.
    const m = EXEC.match(/RUN_DEADLINE_MS\s*=\s*([\d\s*]+);/);
    expect(m, "RUN_DEADLINE_MS not found").toBeTruthy();
    const deadline = Function(`return ${m![1]}`)() as number;
    const leaseMs = Function(
      `return ${fs.readFileSync(path.join(ROOT, "src", "lib", "browserTasks.ts"), "utf8")
        .match(/LEASE_MS\s*=\s*([\d\s*_]+);/)![1]
        .replace(/_/g, "")}`,
    )() as number;
    expect(deadline).toBeGreaterThan(60_000);
    expect(deadline).toBeLessThan(leaseMs);
  });

  it("does not click submit after the deadline has passed", () => {
    // Everything before the click can be abandoned safely. The click cannot:
    // by then the page may no longer be the page we read.
    const beforeClick = EXEC.slice(0, EXEC.indexOf("submit.click()"));
    expect(beforeClick).toMatch(/runLeftMs\(\) <= 0/);
  });

  it("still waits the full window for a confirmation after clicking", () => {
    // Cutting this short would report "we could not confirm it" about an
    // application that did land, and send the user to check it by hand.
    const afterClick = EXEC.slice(EXEC.indexOf("submit.click()"));
    expect(afterClick).not.toMatch(/budget\(/);
  });
});
