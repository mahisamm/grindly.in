import { describe, expect, it, vi } from "vitest";
import type { Report } from "@/lib/reportTypes";
import {
  scrubContact,
  toPublicReport,
  readAdvice,
  readContact,
  readFidelity,
  readReport,
  readStrings,
  readTargetSpec,
} from "@/lib/reportTypes";

/**
 * The boundary where a jsonb column stops being data of unknown shape.
 *
 * These columns are written by a Python subprocess and read back after schema
 * changes, pipeline changes and restored backups. Before this, every reader did
 * its own `JSON.parse` in its own try/catch and cast the result to the type it
 * wanted — so a report whose shape had drifted was a `Report` as far as
 * TypeScript was concerned, and the first thing to notice was a page rendering
 * `undefined` where a score should be.
 *
 * The rule under test is the same everywhere: a value that does not match comes
 * back as null and the page still renders. This product's answer to "we could
 * not read this" is a sentence on screen, never a 500.
 */

const VALID_REPORT = {
  score: 74,
  grade: "B",
  bands: { readable: { score: 1, weight: 30, points: 30 } },
  findings: [{ severity: "critical", band: "readable", problem: "No text", fix: "Re-export" }],
  facts: { readable: { chars: 2400 } },
  targeted: false,
};

describe("readReport", () => {
  it("accepts what the pipeline actually produces", () => {
    const report = readReport(VALID_REPORT);
    expect(report?.score).toBe(74);
    expect(report?.findings[0].severity).toBe("critical");
  });

  it("fills in the collections the UI iterates over", () => {
    // Every consumer does `report.findings.map(...)`. A report missing the key
    // entirely must not become a crash in a component.
    const report = readReport({ score: 10, grade: "D" });
    expect(report?.findings).toEqual([]);
    expect(report?.bands).toEqual({});
    expect(report?.targeted).toBe(false);
  });

  it("keeps `facts` open, because the pipeline adds to it freely", () => {
    const report = readReport({
      ...VALID_REPORT,
      facts: { impact: { bullets: 12, verbs: ["led", "built"], nested: { any: true } } },
    });
    expect(report?.facts.impact.bullets).toBe(12);
  });

  it("returns null for a report that is not one", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A score that is a string is the realistic drift: JSON from a language
    // where everything is a string until someone casts it.
    expect(readReport({ score: "74", grade: "B" })).toBe(null);
    expect(readReport("a string")).toBe(null);
    expect(readReport(42)).toBe(null);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("returns null for an absent column without complaining", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(readReport(null)).toBe(null);
    expect(readReport(undefined)).toBe(null);
    // An empty column is the normal state of a resume nobody has scored yet.
    // Logging it as a schema mismatch would make the log useless.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("rejects a severity outside the two the UI can render", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      readReport({ ...VALID_REPORT, findings: [{ severity: "nag", band: "x", problem: "p", fix: "f" }] }),
    ).toBe(null);
    spy.mockRestore();
  });
});

describe("readFidelity", () => {
  it("reads the headline claim", () => {
    const f = readFidelity({ total: 51, recovered: 47, lost: ["Kafka"], pct: 92 });
    expect(f).toEqual({ total: 51, recovered: 47, lost: ["Kafka"], pct: 92 });
  });

  it("defaults `lost` so the UI can list it", () => {
    expect(readFidelity({ total: 4, recovered: 4, pct: 100 })?.lost).toEqual([]);
  });
});

describe("readStrings", () => {
  it("is always an array", () => {
    expect(readStrings(["Python", "SQL"])).toEqual(["Python", "SQL"]);
    expect(readStrings(null)).toEqual([]);
    expect(readStrings("Python")).toEqual([]);
    expect(readStrings([1, 2])).toEqual([]);
  });
});

describe("readTargetSpec", () => {
  it("reads a company pack's keywords", () => {
    expect(readTargetSpec({ skills: ["Java", "AWS"] })?.skills).toEqual(["Java", "AWS"]);
  });

  it("keeps the marker that says whose claim this is", () => {
    // The whole design of the `notes` kind rests on this field surviving the
    // round trip: it is what lets the UI label the panel "from you · not
    // verified" rather than presenting hearsay as something we checked.
    expect(readTargetSpec({ skills: [], source: "user" })?.source).toBe("user");
  });

  it("defaults every list a consumer might iterate", () => {
    const spec = readTargetSpec({});
    expect(spec?.skills).toEqual([]);
    expect(spec?.emphasis).toEqual([]);
    expect(spec?.must_have).toEqual([]);
  });
});

describe("readContact", () => {
  it("never returns null, because every caller spreads it", () => {
    expect(readContact(null)).toEqual({});
  });

  it("passes through fields the parser found that the schema does not name", () => {
    // Contact extraction reads whatever the header offers — GPA, marks, a
    // portfolio URL. A strict schema would silently drop them.
    const contact = readContact({ email: "a@b.com", gpa: "8.7" });
    expect(contact.email).toBe("a@b.com");
    expect((contact as Record<string, unknown>).gpa).toBe("8.7");
  });
});

describe("readAdvice", () => {
  it("defaults all three lists", () => {
    expect(readAdvice({})).toEqual({ strengths: [], issues: [], suggestions: [] });
  });
});

describe("toPublicReport", () => {
  /**
   * The share link promises to expose the measurement and not the person, and
   * it did not. Caught by fetching a real share URL off production and grepping
   * the HTML for the test account's contact details — both were in it, inside
   * report.facts.fields, which nothing renders and everything serialises.
   */
  const WITH_PII: Report = {
    score: 78,
    grade: "B",
    bands: { readable: { score: 75, weight: 35, points: 26 } },
    findings: [
      {
        severity: "warning",
        band: "fields",
        problem: "We could not read a phone number.",
        fix: "Write it as +91 98765 43210 rather than behind an icon.",
      },
    ],
    facts: {
      fields: {
        emails: ["priya@example.com"],
        phones: ["+91 98765 43210"],
        links: ["github.com/priya-r"],
        date_ranges: 2,
      },
      impact: { bullets: 4 },
    },
    targeted: false,
  };

  it("carries no contact details at all", () => {
    const blob = JSON.stringify(toPublicReport(WITH_PII));
    expect(blob).not.toContain("priya@example.com");
    expect(blob).not.toContain("98765");
    expect(blob).not.toContain("github.com/priya-r");
  });

  it("keeps the measurement, which is the whole point of sharing", () => {
    const publicReport = toPublicReport(WITH_PII);
    expect(publicReport.score).toBe(78);
    expect(publicReport.grade).toBe("B");
    expect(publicReport.bands.readable.points).toBe(26);
    expect(publicReport.findings).toHaveLength(1);
    expect(publicReport.findings[0].problem).toContain("could not read a phone number");
  });

  it("drops facts wholesale, because nothing renders them", () => {
    expect(toPublicReport(WITH_PII).facts).toEqual({});
  });

  it("scrubs a finding that quotes contact details", () => {
    // Findings are generated sentences today. The scorer is free to change, and
    // a share link is the wrong place to discover that one started quoting the
    // header.
    expect(toPublicReport(WITH_PII).findings[0].fix).not.toContain("98765");
  });
});

describe("scrubContact", () => {
  it("removes emails and phone numbers in the shapes this audience uses", () => {
    expect(scrubContact("write to priya.r+jobs@example.co.in today")).not.toContain("@example");
    expect(scrubContact("call +91 98765 43210")).not.toContain("98765");
    expect(scrubContact("call 098765-43210")).not.toContain("43210");
  });

  it("leaves ordinary sentences alone", () => {
    const sentence = "Only 50% of bullets start with an action verb.";
    expect(scrubContact(sentence)).toBe(sentence);
  });
});
