import { describe, it, expect } from "vitest";
import {
  PROFF_FIELDS,
  DEFAULTS,
  GRAD_YEARS,
  missingRequired,
  blankOptional,
} from "@/lib/proffQuestions";

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

/**
 * Required questions exist because a measured dry run of real application pages
 * stalled on them. The rules that matter are which answers count as answers:
 * "0" and "No" are facts a form can be filled with, and treating either as a
 * blank would put the user in a loop they cannot exit.
 */
describe("required setup questions", () => {
  it("blocks setup on the questions real forms were measured to stop on", () => {
    const gaps = missingRequired({ ...DEFAULTS });
    expect(gaps.map((f) => f.key).sort()).toEqual(["currentSalary", "previousInternship"]);
  });

  it("counts a picked '0' as an answer, not a blank", () => {
    // A student earning nothing HAS a current salary, and the option list offers
    // it. Refusing the pick would demand an answer the form itself accepts as 0.
    const gaps = missingRequired({ ...DEFAULTS, currentSalary: "0", previousInternship: "No" });
    expect(gaps).toEqual([]);
  });

  it("does not count a numeric 0 as an answer", () => {
    // Same rule as agent/questions.py (`if matches and value`): every numeric
    // field in DEFAULTS starts at 0 as its empty marker, and nobody scored 0%
    // in class 12. Disagreeing with the agent here is how a field reads as
    // filled in setup and blank at apply time.
    const blanks = blankOptional({ ...DEFAULTS, class12Percent: 0 }).map((f) => f.key);
    expect(blanks).toContain("class12Percent");
    expect(blankOptional({ ...DEFAULTS, class12Percent: 82 }).map((f) => f.key)).not.toContain(
      "class12Percent",
    );
  });

  it("treats whitespace as unanswered", () => {
    const gaps = missingRequired({ ...DEFAULTS, currentSalary: "   ", previousInternship: "No" });
    expect(gaps.map((f) => f.key)).toEqual(["currentSalary"]);
  });

  it("names the optional blanks instead of hiding them", () => {
    // Every one of these stalls some application eventually; the user is the
    // only one who can fill them, so they have to be told which.
    const blanks = blankOptional({ ...DEFAULTS }).map((f) => f.key);
    expect(blanks).toContain("class12Percent");
    expect(blanks).toContain("currentLocation");
    // A required field is reported by missingRequired, never twice.
    expect(blanks).not.toContain("currentSalary");
  });

  it("stops naming a blank once it is filled", () => {
    const blanks = blankOptional({ ...DEFAULTS, currentLocation: "Hyderabad" }).map((f) => f.key);
    expect(blanks).not.toContain("currentLocation");
  });

  it("gives every required field a one-tap way to answer it", () => {
    // A required box with no options is a required essay. Both of these are
    // answerable in one tap by someone who has never been employed.
    for (const f of PROFF_FIELDS.filter((x) => x.required)) {
      expect(["select", "choice"], `${f.key} is free text`).toContain(f.type);
      expect(f.options!.length, `${f.key} has no options`).toBeGreaterThan(1);
    }
  });
});
