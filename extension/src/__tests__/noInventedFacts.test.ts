import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The question a live test could not reach: does Grindly invent a fact?
 *
 * Internshala's Quick Apply never asks for a CGPA or a graduation year — those
 * live in a one-time profile, not the per-application form — so no amount of
 * testing against real Internshala listings can exercise this. That does not
 * make the risk theoretical: LinkedIn, Naukri and Unstop do ask, and the moment
 * one of those is connected, whatever this engine does becomes a claim made to
 * an employer under the user's name.
 *
 * So the form is built here, asking exactly the things that would be damaging
 * to guess, and the real shipped fill engine is run against it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GF: any;

beforeAll(() => {
  const code = fs.readFileSync(
    path.resolve(__dirname, "..", "fillEngine.js"), "utf8",
  );
  new Function(code)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GF = (globalThis as any).GrindlyFill;
});

type Field = { tag: string; type?: string; name: string; label: string; filled?: boolean };

/** A screening form of the kind LinkedIn/Naukri/Unstop actually serve. */
function screeningForm(): Field[] {
  return [
    { tag: "input", type: "text", name: "full_name", label: "Full name" },
    { tag: "input", type: "email", name: "email", label: "Email address" },
    { tag: "input", type: "tel", name: "phone", label: "Mobile number" },
    // Every one of these below is a FACT. Guessing any of them puts a false
    // claim in front of an employer, signed by the candidate.
    { tag: "input", type: "text", name: "cgpa", label: "What is your CGPA?" },
    { tag: "input", type: "text", name: "grad", label: "Year of graduation" },
    { tag: "input", type: "text", name: "notice", label: "Notice period (in days)" },
    { tag: "input", type: "text", name: "ctc", label: "Current CTC" },
    { tag: "input", type: "text", name: "sponsor", label: "Will you require visa sponsorship?" },
    { tag: "textarea", name: "why", label: "Why should you be hired for this role?" },
  ];
}

const KIT_WITHOUT_FACTS = {
  profile: { name: "Mahendhar Sammeta", email: "m@example.com", phone: "9000000000" },
  answers: [],
  coverLetter: "I built and shipped a full-stack agent.",
};

function filledFor(kit: unknown) {
  const fields = screeningForm();
  const plan = GF.planFills(fields, kit);
  const out: Record<string, string> = {};
  for (const p of plan) out[fields[p.i].name] = p.value;
  return out;
}

describe("it does not invent facts it was never given", () => {
  it("leaves CGPA blank when no CGPA was provided", () => {
    // The single most damaging one: a fabricated grade is checkable, and the
    // candidate is the one who has to defend it in the room.
    expect(filledFor(KIT_WITHOUT_FACTS).cgpa).toBeUndefined();
  });

  it.each([
    ["grad", "graduation year"],
    ["notice", "notice period"],
    ["ctc", "current CTC"],
    ["sponsor", "visa sponsorship"],
  ])("leaves %s blank rather than guessing (%s)", (field) => {
    expect(filledFor(KIT_WITHOUT_FACTS)[field]).toBeUndefined();
  });

  it("still fills the contact details it genuinely holds", () => {
    // Refusing to invent must not turn into refusing to help.
    const filled = filledFor(KIT_WITHOUT_FACTS);
    expect(filled.full_name).toBe("Mahendhar Sammeta");
    expect(filled.email).toBe("m@example.com");
    expect(filled.phone).toBe("9000000000");
  });

  it("uses the real CGPA when the user actually supplied one", () => {
    const filled = filledFor({
      ...KIT_WITHOUT_FACTS,
      profile: { ...KIT_WITHOUT_FACTS.profile, gpa: 8.4 },
    });
    expect(filled.cgpa).toBe("8.4");
  });

  it("answers a screening question only from an approved answer", () => {
    const approved = filledFor({
      ...KIT_WITHOUT_FACTS,
      answers: [{ q: "Notice period (in days)", a: "30" }],
    });
    expect(approved.notice).toBe("30");
    // ...and nothing else leaked in alongside it.
    expect(approved.cgpa).toBeUndefined();
    expect(approved.ctc).toBeUndefined();
  });

  it("never overwrites something the page or the user already set", () => {
    const fields = screeningForm();
    fields[3] = { ...fields[3], filled: true };
    const plan = GF.planFills(fields, {
      ...KIT_WITHOUT_FACTS,
      profile: { ...KIT_WITHOUT_FACTS.profile, gpa: 9.9 },
    });
    expect(plan.find((p: { i: number }) => p.i === 3)).toBeUndefined();
  });

  it("writes a cover letter only into a cover-letter field", () => {
    const filled = filledFor(KIT_WITHOUT_FACTS);
    expect(filled.why).toBe("I built and shipped a full-stack agent.");
    // A cover letter pasted into "What is your CGPA?" would be both wrong and
    // absurd, and is exactly what a looser matcher would do.
    expect(filled.cgpa).toBeUndefined();
  });
});

describe("what it cannot answer, it hands back", () => {
  it("reports every unanswered required question by name", () => {
    const code = fs.readFileSync(
      path.resolve(__dirname, "..", "humanGate.js"), "utf8",
    );
    new Function(code)();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gate = (globalThis as any).GrindlyGate;

    const visible = { offsetParent: {} };
    const doc = {
      querySelector: () => null,
      querySelectorAll: () => [
        { ...visible, type: "text", value: "", id: "cgpa", name: "cgpa",
          getAttribute: () => "What is your CGPA?" },
        { ...visible, type: "text", value: "2027", id: "grad", name: "grad",
          getAttribute: () => "Year of graduation" },
      ],
      body: { innerText: "" },
    } as unknown as Document;

    // The blocked question is named, so the user is told WHICH one stopped the
    // application instead of a vague "needs your input" — and the answered one
    // is not nagged about.
    expect(gate.unansweredRequiredFields(doc)).toEqual(["What is your CGPA?"]);
  });
});
