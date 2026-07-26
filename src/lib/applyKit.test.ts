import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { buildKit } from "./applyKit";

/**
 * These two pieces of code have to agree, and did not.
 *
 * The claim endpoint returned a flat { fullName, email, … } while fillEngine
 * reads kit.profile.name. It found undefined, filled nothing, and every
 * autopilot run then reported that the form had asked something it could not
 * answer. Nothing crashed and no test failed — the shapes simply did not meet.
 *
 * So the real shipped fill engine is run against the real builder here.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GF: any;
beforeAll(() => {
  const code = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "extension", "src", "fillEngine.js"), "utf8",
  );
  new Function(code)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GF = (globalThis as any).GrindlyFill;
});

const USER = {
  name: "Mahendhar Sammeta",
  email: "m@example.com",
  profile: {
    phone: "9000000000", gpa: 8.4, gradYear: 2027,
    education: "B.Tech Computer Science", availability: "Immediately",
    workAuthorization: "Indian citizen",
  },
};

const FORM = [
  { tag: "input", type: "text", name: "name", label: "Full name" },
  { tag: "input", type: "email", name: "email", label: "Email address" },
  { tag: "input", type: "tel", name: "phone", label: "Mobile number" },
  { tag: "input", type: "text", name: "cgpa", label: "What is your CGPA?" },
  { tag: "input", type: "text", name: "grad", label: "What is your year of graduation?" },
  { tag: "textarea", name: "why", label: "Why should you be hired for this role?" },
];

function fill(kit: unknown) {
  const out: Record<string, string> = {};
  for (const p of GF.planFills(FORM, kit)) out[FORM[p.i].name] = p.value;
  return out;
}

describe("the kit the extension is handed", () => {
  it("is actually readable by the fill engine", () => {
    const filled = fill(buildKit(USER, { coverLetterText: "I shipped an agent.", answersJson: null }));
    expect(filled.name).toBe("Mahendhar Sammeta");
    expect(filled.email).toBe("m@example.com");
    expect(filled.phone).toBe("9000000000");
    expect(filled.cgpa).toBe("8.4");
    expect(filled.why).toBe("I shipped an agent.");
  });

  it("answers setup facts phrased as a form would ask them", () => {
    expect(fill(buildKit(USER)).grad).toBe("2027");
  });

  it("still refuses to invent what the user never gave", () => {
    const bare = { name: "A", email: "a@b.c", profile: { phone: "1" } };
    const filled = fill(buildKit(bare));
    expect(filled.cgpa).toBeUndefined();
    expect(filled.grad).toBeUndefined();
  });

  it("puts this job's drafted answer ahead of a standing setup fact", () => {
    // The matcher takes the first hit, and a reply the user reviewed for this
    // employer should beat a generic answer collected months ago.
    const kit = buildKit(USER, {
      coverLetterText: null,
      answersJson: JSON.stringify([{ q: "What is your year of graduation?", a: "2026" }]),
    });
    expect(fill(kit).grad).toBe("2026");
  });

  it("survives a malformed draft without losing the profile fills", () => {
    const filled = fill(buildKit(USER, { coverLetterText: null, answersJson: "{not json" }));
    expect(filled.name).toBe("Mahendhar Sammeta");
    expect(filled.cgpa).toBe("8.4");
  });

  it("carries no empty answers, which would fill a field with nothing", () => {
    const kit = buildKit({ name: "A", email: "a@b.c", profile: {} });
    expect(kit.answers.every((x) => x.a !== "")).toBe(true);
  });
});
