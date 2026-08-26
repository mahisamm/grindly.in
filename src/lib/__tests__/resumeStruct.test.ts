import { describe, expect, it } from "vitest";
import { extractionCoverage, LIMITS, readStruct, sanitizeStruct, structToText } from "@/lib/resumeStruct";

/**
 * The editor's boundary.
 *
 * This structure arrives from a browser and is handed to a renderer that prints
 * it, so the interesting cases are all about what happens to a shape that is
 * nearly right. Truncation is preferred to rejection nearly everywhere:
 * somebody who pastes a paragraph into a bullet has made a formatting mistake,
 * not an attack, and answering that with a red error and a lost draft is a
 * worse product than a bullet that came back shorter.
 */

const VALID = {
  name: "Priya Sharma",
  contact_line: "priya@example.com | Bengaluru",
  sections: [
    {
      heading: "EXPERIENCE",
      items: [
        {
          head: "Backend Engineer",
          sub: "Freshworks, 2024 - Present",
          bullets: ["Cut import time from 40 minutes to 6."],
        },
      ],
    },
  ],
};

describe("sanitizeStruct", () => {
  it("detects an editor extraction that omitted most of the source", () => {
    const source = [
      "Asha Rao asha@example.com",
      "EDUCATION Bachelor of Technology in Computer Science, Anurag University, CGPA 8.7",
      "EXPERIENCE Software Engineering Intern at Acme Systems, Jun 2025 to Aug 2025",
      "Built APIs with Python FastAPI PostgreSQL and Docker for 400 student users.",
      "PROJECTS Placement Portal using React TypeScript Node.js and MongoDB.",
    ].join("\n");
    const partial = sanitizeStruct({
      name: "Asha Rao",
      contact_line: "asha@example.com",
      sections: [{ heading: "Projects", items: [{ head: "Placement Portal", sub: "", bullets: ["Built a portal."] }] }],
    });
    expect(partial).not.toBeNull();
    expect(extractionCoverage(source, partial!).ratio).toBeLessThan(0.6);
  });

  it("keeps a real resume intact", () => {
    expect(sanitizeStruct(VALID)).toEqual(VALID);
  });

  it("fills in the fields the renderer indexes into", () => {
    // build_html reads item.head, item.sub and item.bullets unconditionally. A
    // missing key there is a crash in Python, on the far side of a subprocess
    // boundary, reported to the user as "the render step returned nothing".
    const clean = sanitizeStruct({ sections: [{ items: [{ head: "Engineer" }] }] });
    expect(clean?.name).toBe("");
    expect(clean?.contact_line).toBe("");
    expect(clean?.sections[0].items[0].sub).toBe("");
    expect(clean?.sections[0].items[0].bullets).toEqual([]);
  });

  it("drops empty bullets rather than printing a lone glyph", () => {
    const clean = sanitizeStruct({
      sections: [{ heading: "X", items: [{ head: "A", sub: "", bullets: ["real", "", "  "] }] }],
    });
    expect(clean?.sections[0].items[0].bullets).toEqual(["real"]);
  });

  it("drops a section that is entirely empty", () => {
    const clean = sanitizeStruct({
      sections: [
        { heading: "", items: [{ head: "", sub: "", bullets: [] }] },
        { heading: "EXPERIENCE", items: [{ head: "Engineer", sub: "", bullets: [] }] },
      ],
    });
    expect(clean?.sections).toHaveLength(1);
    expect(clean?.sections[0].heading).toBe("EXPERIENCE");
  });

  it("truncates rather than rejecting an over-long field", () => {
    const clean = sanitizeStruct({
      name: "x".repeat(500),
      sections: [
        { heading: "X", items: [{ head: "A", sub: "", bullets: ["y".repeat(5000)] }] },
      ],
    });
    expect(clean?.name.length).toBe(LIMITS.nameChars);
    expect(clean?.sections[0].items[0].bullets[0].length).toBe(LIMITS.bulletChars);
  });

  it("bounds the size of what will be rendered", () => {
    // Chromium renders this on a one-vCPU box with the rest of the stack
    // running. These caps are generous against any real resume and exist for
    // the request that is not one.
    const clean = sanitizeStruct({
      sections: Array.from({ length: 200 }, () => ({
        heading: "S",
        items: Array.from({ length: 200 }, () => ({
          head: "H",
          sub: "",
          bullets: Array.from({ length: 200 }, () => "b"),
        })),
      })),
    });
    expect(clean!.sections.length).toBe(LIMITS.sections);
    expect(clean!.sections[0].items.length).toBe(LIMITS.itemsPerSection);
    expect(clean!.sections[0].items[0].bullets.length).toBe(LIMITS.bulletsPerItem);
  });

  it("refuses a structure with nothing in it", () => {
    // Rendering one produces a blank PDF that scores badly and reads as a
    // broken tool rather than as an empty document.
    expect(sanitizeStruct({ sections: [] })).toBe(null);
    expect(sanitizeStruct({ name: "Priya", sections: [] })).toBe(null);
    expect(sanitizeStruct({})).toBe(null);
  });

  it("refuses a shape that is not this shape", () => {
    expect(sanitizeStruct(null)).toBe(null);
    expect(sanitizeStruct("a resume")).toBe(null);
    expect(sanitizeStruct({ sections: "EXPERIENCE" })).toBe(null);
    // A bullets value that arrived as a string is the specific bug the Python
    // side documents: iterated character by character, it emits one bullet per
    // letter.
    expect(
      sanitizeStruct({ sections: [{ heading: "X", items: [{ head: "A", bullets: "one two" }] }] }),
    ).toBe(null);
  });
});

describe("readStruct", () => {
  it("returns null for a column nobody has written yet", () => {
    expect(readStruct(null)).toBe(null);
    expect(readStruct(undefined)).toBe(null);
  });

  it("parses what sanitizeStruct produces", () => {
    expect(readStruct(sanitizeStruct(VALID))).toEqual(VALID);
  });
});

describe("structToText", () => {
  it("produces text the scorer can read", () => {
    const text = structToText(sanitizeStruct(VALID)!);
    expect(text).toContain("Priya Sharma");
    expect(text).toContain("EXPERIENCE");
    expect(text).toContain("Backend Engineer");
    // The bullet glyph matters: readiness.py detects real bullets, and a
    // rebuilt document that lost them scores lower on structure than the
    // document it was built from.
    expect(text).toContain("• Cut import time");
  });

  it("puts every section on its own line", () => {
    const text = structToText(sanitizeStruct(VALID)!);
    expect(text.split("\n").filter(Boolean).length).toBeGreaterThan(3);
  });
});
