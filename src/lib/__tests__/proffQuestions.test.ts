import { describe, it, expect } from "vitest";
import {
  PROFF_FIELDS,
  DEFAULTS,
  GRAD_YEARS,
  missingRequired,
  blankOptional,
  unfilledFacts,
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
  // Everything required, answered — the baseline the cases below vary one
  // field away from.
  function answeredAll(over: Record<string, unknown> = {}) {
    const filled: Record<string, unknown> = { ...DEFAULTS };
    for (const f of PROFF_FIELDS.filter((x) => x.required)) {
      filled[f.key] = f.numeric || f.type === "number" ? 1 : "answered";
    }
    return { ...filled, ...over };
  }

  it("blocks setup on the questions real forms were measured to stop on", () => {
    const gaps = missingRequired({ ...DEFAULTS }).map((f) => f.key);
    expect(gaps).toContain("currentSalary");
    expect(gaps).toContain("previousInternship");
  });

  it("counts a picked '0' as an answer, not a blank", () => {
    // A student earning nothing HAS a current salary, and the option list offers
    // it. Refusing the pick would demand an answer the form itself accepts as 0.
    const gaps = missingRequired(answeredAll({ currentSalary: "0", previousInternship: "No" }));
    expect(gaps).toEqual([]);
  });

  it("does not count a numeric 0 as an answer", () => {
    // Same rule as agent/questions.py (`if matches and value`): every numeric
    // field in DEFAULTS starts at 0 as its empty marker, and nobody scored 0%
    // in class 12. Disagreeing with the agent here is how a field reads as
    // filled in setup and blank at apply time.
    const blanks = blankOptional({ ...DEFAULTS, class10Percent: 0 }).map((f) => f.key);
    expect(blanks).toContain("class10Percent");
    expect(blankOptional({ ...DEFAULTS, class10Percent: 82 }).map((f) => f.key)).not.toContain(
      "class10Percent",
    );
  });

  it("treats whitespace as unanswered", () => {
    const gaps = missingRequired(answeredAll({ currentSalary: "   " }));
    expect(gaps.map((f) => f.key)).toEqual(["currentSalary"]);
  });

  it("names the optional blanks instead of hiding them", () => {
    // Every one of these stalls some application eventually; the user is the
    // only one who can fill them, so they have to be told which.
    const blanks = blankOptional({ ...DEFAULTS }).map((f) => f.key);
    expect(blanks).toContain("class10Percent");
    expect(blanks).toContain("gender");
    // A required field is reported by missingRequired, never twice.
    expect(blanks).not.toContain("currentSalary");
    expect(blanks).not.toContain("currentLocation");
  });

  it("stops naming a blank once it is filled", () => {
    const blanks = blankOptional({ ...DEFAULTS, gender: "Prefer not to say" }).map((f) => f.key);
    expect(blanks).not.toContain("gender");
  });

  it("gives every required field a one-tap way to answer it", () => {
    // A required box with no options is a required essay. The exceptions are
    // the two the resume normally fills in for you — a college name and a board
    // percentage cannot come from a list, and arrive pre-filled when the read
    // works.
    // Date of birth joins them: it stopped a real application, so it is asked
    // up front, and there is no list of every date a person could be born on.
    const typedByHand = ["college", "class12Percent", "dateOfBirth"];
    for (const f of PROFF_FIELDS.filter((x) => x.required && !typedByHand.includes(x.key))) {
      expect(["select", "choice"], `${f.key} is free text`).toContain(f.type);
      // A dropdown whose stored value differs from its label carries `choices`
      // instead of `options` — gradMonth keeps month NUMBERS against month
      // names. Still one tap; reading only `options` said it had none at all.
      const picks = f.options ?? f.choices?.map((c) => c.value);
      expect(picks!.length, `${f.key} has no options`).toBeGreaterThan(0);
      // A "select" is the whole world of answers, so one option is a question
      // with no answer. A "choice" always offers "Something else…", so a single
      // listed option ("Country: India") is still a one-tap answer for almost
      // everyone and never traps the person it does not fit.
      if (f.type === "select") {
        expect(picks!.length, `${f.key} offers no real choice`).toBeGreaterThan(1);
      }
    }
  });
});

/**
 * Setup asked twenty-six questions before anyone had seen an application go
 * out, and the owner abandoned it halfway through typing facts their own resume
 * already stated. What is VISIBLE on the way in is now the thing under test.
 */
describe("how much setup asks for", () => {
  const asked = PROFF_FIELDS.filter(
    (f) => (f.group === "About you" || f.group === "Education") && !f.advanced,
  );

  it("keeps the questions asked up front down to something answerable", () => {
    // The number moves only for a question a real application was MEASURED to
    // stop on — two of these were added after a live run refused three
    // employer forms for facts that were sitting hidden under "More answers".
    // It is a ceiling on drift, not a target: the wall this replaced was 26.
    //
    // 13 -> 15 on 2026-08-02, under that same rule. The first live send to real
    // employers stopped at the submit button twice: Ken Research on "Gender *"
    // (the field existed but was folded under "More answers", so it was blank on
    // every account) and Dash Technologies on "Total Years of Experience *"
    // (which had no field anywhere). Gender is required on Keka, which is the
    // single largest source of Indian internships we have.
    //
    // 15 -> 16 on 2026-08-02, same rule again. A live AlphaGrep Securities
    // application filled every other field and stopped on "Start date year*" —
    // the year the degree BEGAN, which Greenhouse asks as its own required box
    // on the education block and which had no field anywhere in the product.
    // Deliberately asked rather than derived: graduation year minus a course
    // length is a guess, wrong for anyone who took a gap or repeated a year,
    // and it would be stated as fact on an employer's form.
    expect(asked.length).toBeLessThanOrEqual(16);
  });

  it("only blocks on questions the agent is genuinely stuck without", () => {
    const required = PROFF_FIELDS.filter((f) => f.required).map((f) => f.key);
    // The two a measured dry run stalled on, plus eligibility facts no resume
    // carries and no application can be finished without.
    expect(required).toContain("currentSalary");
    expect(required).toContain("previousInternship");
    expect(required).toContain("availability");
    // Added on the same evidence, from a live run: "Expected Salary *" and
    // "Graduation Month & Year *" each stopped a real application dead, and
    // both are a single tap from a list.
    expect(required).toContain("expectedStipend");
    expect(required).toContain("gradMonth");
    expect(required).not.toContain("gender");
    // Asked up front too: a form stopped on it, and one typed line at signup
    // beats an application that silently waits for it afterwards.
    expect(required).toContain("dateOfBirth");
    // Grindly only applies to internships in India. Asking every user to
    // confirm the country they are in, and that they may work there, is asking
    // them to restate the product's own premise — so both are preset and
    // editable rather than demanded.
    expect(required).not.toContain("country");
    expect(required).not.toContain("workAuthorization");
  });

  it("presets the product's scope, but never a claim about the person", () => {
    // The line between these two is the point. `country` is the scope of the
    // product: someone signing up to an India internship service has chosen
    // the country, and stating it invents nothing.
    expect(DEFAULTS.country).toBe("India");

    // Citizenship, nationality and sponsorship are legal claims ABOUT THE
    // USER, typed verbatim onto a real employer's form — and false for a real
    // slice of the people this product serves: international students studying
    // in India, OCI holders, anyone on a student visa. Both fields are
    // `advanced`, so the median user never saw the claim being made in their
    // name. A wrong answer here misstates work eligibility to an employer.
    expect(DEFAULTS.workAuthorization).toBe("");
    expect(DEFAULTS.nationality).toBe("");
    expect(DEFAULTS.needsSponsorship).toBe("");

    for (const key of ["country", "workAuthorization", "nationality"]) {
      expect(PROFF_FIELDS.find((f) => f.key === key)!.advanced, key).toBe(true);
    }
  });

  it("never states a stipend the user did not pick", () => {
    // expectedStipend defaulted to 0, and `answered()` treats any number as
    // answered when zeroIsAnAnswer is set — so `required` was inert AND every
    // untouched account stated "₹0/mo" to employers as its expected pay. null
    // is genuinely unanswered, so the field can block and the setup-gap prompt
    // can ask for it.
    expect(DEFAULTS.expectedStipend).toBeNull();
    expect(missingRequired({ ...DEFAULTS }).map((f) => f.key))
      .toContain("expectedStipend");
  });

  it("does not pre-consent to applying on the user's behalf", () => {
    // autoApply authorises software to submit under the student's own name.
    // Shipping it pre-flipped assumed consent before they read what it does.
    expect(DEFAULTS.autoApply).toBe(false);
  });

  it("never hides a required question behind the More toggle", () => {
    // A blocked step whose blocking field is folded away is a dead end.
    for (const f of PROFF_FIELDS.filter((x) => x.required)) {
      expect(f.advanced, `${f.key} is required AND hidden`).toBeFalsy();
    }
  });

  it("makes every visible question answerable in one tap where it can be", () => {
    // College and the percentages are genuinely free text or numeric; the rest
    // of what we ask for up front is a list to pick from.
    // A date of birth and a portfolio URL cannot be a list either, and both
    // were measured stopping real applications while hidden — so they are shown
    // and left optional rather than folded away and silently costing sends.
    const typed = asked.filter(
      (f) => !["select", "choice"].includes(f.type) && !f.choices,
    );
    expect(typed.map((f) => f.key).sort()).toEqual(
      ["class12Percent", "college", "dateOfBirth", "portfolioUrl"].sort(),
    );
  });

  it("asks about pay as a choice, not as a number to guess at", () => {
    // "Minimum monthly stipend" invited a figure people over-estimate, and the
    // matcher then filtered their whole queue away.
    const stipend = PROFF_FIELDS.find((f) => f.key === "stipendMin")!;
    expect(stipend.choices).toBeTruthy();
    expect(stipend.choices!.map((c) => c.value).sort()).toEqual(["0", "1"]);
    expect(stipend.choices!.some((c) => /unpaid/i.test(c.label))).toBe(true);
  });
});

/**
 * Zero is an answer to exactly one question, and it is now a REQUIRED one — so
 * getting this wrong would leave setup demanding a stipend the user had already
 * picked, forever, with no way past.
 */
describe("a stipend of zero", () => {
  it("counts as answered once picked", () => {
    const form = { ...DEFAULTS, expectedStipend: 0 };
    expect(missingRequired(form).map((f) => f.key)).not.toContain("expectedStipend");
  });

  it("survives the round trip through the Int column", () => {
    // The select hands back the string "0"; /api/profile coerces it to the
    // number 0; the form reloads holding 0. All three have to read as answered
    // or setup blocks on reload.
    for (const value of ["0", 0]) {
      const form = { ...DEFAULTS, expectedStipend: value };
      expect(missingRequired(form).map((f) => f.key)).not.toContain("expectedStipend");
    }
  });

  it("does not loosen the rule for any other numeric question", () => {
    const blanks = blankOptional({ ...DEFAULTS, class10Percent: 0 }).map((f) => f.key);
    expect(blanks).toContain("class10Percent");
  });
});

/**
 * The dashboard prompt that names what the agent is stuck on reads this. It is
 * fed by keys the agent wrote onto the application row at the moment it
 * refused — a SNAPSHOT — so re-asking the live profile is what makes the prompt
 * disappear when the box is filled rather than when the agent next runs.
 */
describe("what the agent is still waiting on", () => {
  it("keeps a fact that is still blank", () => {
    const gaps = unfilledFacts(["dateOfBirth"], { ...DEFAULTS });
    expect(gaps.map((f) => f.key)).toEqual(["dateOfBirth"]);
  });

  it("drops a fact as soon as it is answered", () => {
    const gaps = unfilledFacts(["dateOfBirth"], { ...DEFAULTS, dateOfBirth: "14/03/2005" });
    expect(gaps).toEqual([]);
  });

  it("drops a stipend the user answered with zero", () => {
    // Same rule as everywhere else, and the one that would otherwise leave the
    // prompt demanding an answer already given.
    expect(unfilledFacts(["expectedStipend"], { ...DEFAULTS, expectedStipend: 0 })).toEqual([]);
  });

  it("names each fact once however many applications are waiting on it", () => {
    const gaps = unfilledFacts(["gradMonth", "gradMonth", "gradMonth"], { ...DEFAULTS });
    expect(gaps.map((f) => f.key)).toEqual(["gradMonth"]);
  });

  it("ignores a key that is not a setup question", () => {
    // A form the agent could not read is ours to fix. Sending someone hunting
    // for a box that does not exist is worse than saying nothing.
    expect(unfilledFacts(["somethingWeCannotAsk"], { ...DEFAULTS })).toEqual([]);
  });

  it("carries the label and help text the prompt shows", () => {
    const [gap] = unfilledFacts(["expectedStipend"], { ...DEFAULTS, expectedStipend: null });
    expect(gap.label).toBeTruthy();
    expect(gap.help).toBeTruthy();
  });
});
