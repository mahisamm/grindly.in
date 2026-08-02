import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { PROFF_FIELDS } from "@/lib/proffQuestions";

/**
 * Every question setup asks must be a field this route will actually store.
 *
 * The failure is completely silent, and it happened: `yearsExperience` was added
 * to the schema, to the setup form and to the agent's question engine — but not
 * to this route's allowlist. Setup showed the box, the user answered it, the
 * save returned 200, and the value was dropped on the floor. Nothing in the UI
 * or the response said otherwise, and the agent went on refusing every employer
 * form that asked for it.
 *
 * Read as source rather than imported because the allowlists are module-private
 * Sets inside a route file that pulls in prisma and the session layer.
 */
const source = fs.readFileSync(
  new URL("../route.ts", import.meta.url),
  "utf8",
);

function accepts(key: string): boolean {
  // Each allowlist entry appears as a quoted string in one of the field Sets.
  return new RegExp(`["']${key}["']`).test(source);
}

describe("setup questions and the profile API agree", () => {
  it("stores every question setup asks", () => {
    const dropped = PROFF_FIELDS.map((f) => f.key).filter((k) => !accepts(k));
    expect(dropped, `these setup questions are shown, answered, and then silently discarded on save: ${dropped.join(", ")}`).toEqual([]);
  });

  it("stores every REQUIRED question, which would otherwise deadlock setup", () => {
    // Worse than the general case: readiness gates auto-apply on these, so a
    // required field the API drops means the user can never become ready no
    // matter how many times they answer it.
    const dropped = PROFF_FIELDS.filter((f) => f.required)
      .map((f) => f.key)
      .filter((k) => !accepts(k));
    expect(dropped, `required setup questions the API will not store: ${dropped.join(", ")}`).toEqual([]);
  });

  it("stores the facts the agent refuses to invent", () => {
    // The specific ones a live run was measured to stop on. Named individually
    // so a regression points at the application it would break.
    for (const key of ["gender", "yearsExperience", "dateOfBirth", "gradMonth"]) {
      expect(accepts(key), `${key} is not saveable — the agent will keep stopping at the submit button on forms that ask for it`).toBe(true);
    }
  });
});
