import { describe, it, expect } from "vitest";
import { PROFF_FIELDS, DEFAULTS, GRAD_YEARS } from "@/lib/proffQuestions";

/**
 * Setup is where the agent gets every fact it will state on an application. A
 * field defined here and nowhere else is a question the user answers and the
 * agent never sees — which is what happened to graduation year, availability and
 * work authorization for as long as they existed.
 */
describe("setup questions", () => {
  it("gives every field a default so a save can never post undefined", () => {
    for (const f of PROFF_FIELDS) {
      expect(DEFAULTS, `${f.key} has no default`).toHaveProperty(f.key);
    }
  });

  it("offers a fixed list for every answer typed into a form's own dropdown", () => {
    // Free text here produced values the agent could not use: "asap" is not one
    // of a form's options and cannot be selected.
    for (const key of ["availability", "willingToRelocate", "needsSponsorship", "workAuthorization"]) {
      const field = PROFF_FIELDS.find((f) => f.key === key)!;
      expect(field, key).toBeDefined();
      expect(["select", "choice"], `${key} is still free text`).toContain(field.type);
      expect(field.options!.length).toBeGreaterThan(1);
    }
  });

  it("lets a user answer outside the list where the list cannot be complete", () => {
    // Forcing a pick would make someone state something untrue about themselves.
    for (const key of ["availability", "workAuthorization", "degree"]) {
      expect(PROFF_FIELDS.find((f) => f.key === key)!.type, key).toBe("choice");
    }
  });

  it("keeps sponsorship a strict yes/no, because a form asks it that way", () => {
    const field = PROFF_FIELDS.find((f) => f.key === "needsSponsorship")!;
    expect(field.type).toBe("select");
    expect([...field.options!].sort()).toEqual(["No", "Yes"]);
  });

  it("offers graduation years around now, and stores them as numbers", () => {
    const year = new Date().getFullYear();
    expect(GRAD_YEARS).toContain(String(year));
    expect(GRAD_YEARS).toContain(String(year + 3));
    expect(PROFF_FIELDS.find((f) => f.key === "gradYear")!.numeric).toBe(true);
  });

  it("marks every numeric dropdown, so a number column never receives a string", () => {
    for (const key of ["gradYear", "hoursPerWeek", "expectedStipend"]) {
      expect(PROFF_FIELDS.find((f) => f.key === key)!.numeric, key).toBe(true);
    }
  });

  it("suggests domains and locations rather than leaving them blank", () => {
    // These decide which listings are searched at all — a typo narrows the
    // search to nothing and the user never sees why.
    for (const key of ["preferredDomains", "preferredLocations"]) {
      const field = PROFF_FIELDS.find((f) => f.key === key)!;
      expect(field.suggestions!.length).toBeGreaterThan(5);
    }
  });

  it("asks for the degree and the college separately", () => {
    // Forms ask for them in separate boxes; one combined string answers neither.
    expect(PROFF_FIELDS.find((f) => f.key === "degree")).toBeDefined();
    expect(PROFF_FIELDS.find((f) => f.key === "college")).toBeDefined();
  });
});
