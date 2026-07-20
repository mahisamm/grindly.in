import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Load the EXACT shipped content-script file (no build step, no duplicate copy)
// and pull its API off globalThis, then test the pure decision core.
const EXT = path.resolve(__dirname, "..");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let GF: any;

beforeAll(() => {
  const code = fs.readFileSync(path.join(EXT, "fillEngine.js"), "utf8");
  new Function(code)();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  GF = (globalThis as any).GrindlyFill;
});

type Field = {
  tag: string; type?: string; name?: string; id?: string; label?: string;
  required?: boolean; filled?: boolean; contentEditable?: boolean;
};

const kit = {
  coverLetter: "Hi Acme team, I'm excited to apply...",
  answers: [
    { q: "Why should we hire you?", a: "I shipped three React apps." },
    { q: "How many hours a week can you commit?", a: "40 hours." },
  ],
  profile: { name: "Mahendhar S", email: "m@x.com", phone: "9999999999", gpa: 8.7 },
};

function plan(fields: Field[]) {
  return GF.planFills(fields, kit) as { i: number; value: string; source: string }[];
}

describe("planFills — what gets typed where", () => {
  it("fills the cover-letter textarea with the kit cover letter", () => {
    const p = plan([{ tag: "textarea", name: "cover_letter", label: "Cover letter" }]);
    expect(p).toHaveLength(1);
    expect(p[0].value).toBe(kit.coverLetter);
    expect(p[0].source).toBe("cover");
  });

  it("fills phone / email / name / CGPA straight from the profile", () => {
    const p = plan([
      { tag: "input", type: "tel", label: "Mobile number" },
      { tag: "input", type: "email", label: "Email address" },
      { tag: "input", label: "Full name" },
      { tag: "input", label: "Your CGPA" },
    ]);
    const byVal = p.map((x) => x.value).sort();
    expect(byVal).toEqual(["8.7", "9999999999", "Mahendhar S", "m@x.com"].sort());
    expect(p.every((x) => x.source === "profile")).toBe(true);
  });

  it("matches a drafted answer to a live field by its question label", () => {
    const p = plan([{ tag: "textarea", label: "Why should we hire you?" }]);
    expect(p).toHaveLength(1);
    expect(p[0].value).toBe("I shipped three React apps.");
    expect(p[0].source).toBe("answer");
  });

  it("NEVER returns a decision for submit / button / file / hidden / password", () => {
    const p = plan([
      { tag: "input", type: "submit", label: "Submit application" },
      { tag: "button", type: "button", label: "Apply" },
      { tag: "input", type: "file", label: "Upload resume" },
      { tag: "input", type: "hidden", name: "csrf" },
      { tag: "input", type: "password", label: "Password" },
    ]);
    expect(p).toHaveLength(0);
  });

  it("leaves checkboxes and radios to the user (never auto-checks)", () => {
    const p = plan([
      { tag: "input", type: "checkbox", label: "I agree", required: true },
      { tag: "input", type: "radio", label: "Yes" },
    ]);
    expect(p).toHaveLength(0);
  });

  it("never clobbers an already-filled field", () => {
    const p = plan([{ tag: "textarea", label: "Cover letter", filled: true }]);
    expect(p).toHaveLength(0);
  });

  it("returns nothing for a field it has no value for", () => {
    const p = plan([{ tag: "input", label: "Portfolio URL" }]);
    expect(p).toHaveLength(0);
  });

  it("skips platform plumbing fields by name", () => {
    const p = plan([{ tag: "input", name: "authenticity_token", label: "Full name" }]);
    expect(p).toHaveLength(0);
  });

  it("does not fill a cover letter into a plain text input (only textarea/contenteditable)", () => {
    const p = plan([{ tag: "input", type: "text", label: "Cover letter" }]);
    expect(p).toHaveLength(0);
  });
});

describe("matchAnswer — fuzzy question matching", () => {
  it("matches on exact, containment, and word overlap", () => {
    expect(GF.matchAnswer("Why should we hire you?", kit.answers)).toBe("I shipped three React apps.");
    expect(GF.matchAnswer("hours per week you can commit", kit.answers)).toBe("40 hours.");
    expect(GF.matchAnswer("What is your favourite colour?", kit.answers)).toBeNull();
  });
});
