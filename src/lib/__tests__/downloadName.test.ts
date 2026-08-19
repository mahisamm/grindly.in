import { describe, expect, it } from "vitest";
import { contentDisposition, resumeFileStem } from "@/lib/downloadName";

describe("resumeFileStem", () => {
  it("puts the company first and the person second", () => {
    expect(resumeFileStem("Mahendhar Sammeta", "Zoho")).toBe("Zoho-Mahendhar-Sammeta-Resume");
  });

  it("drops the company when there is not one", () => {
    expect(resumeFileStem("Mahendhar Sammeta")).toBe("Mahendhar-Sammeta-Resume");
    expect(resumeFileStem("Mahendhar Sammeta", "")).toBe("Mahendhar-Sammeta-Resume");
    expect(resumeFileStem("Mahendhar Sammeta", null)).toBe("Mahendhar-Sammeta-Resume");
  });

  it("still produces a usable name when nothing is known", () => {
    // Reachable: a resume built in the editor before anyone typed a name into
    // the header field. A download called "-.pdf" is worse than a generic one.
    expect(resumeFileStem("", "")).toBe("Resume");
    expect(resumeFileStem(null, null)).toBe("Resume");
    expect(resumeFileStem("   ", "!!!")).toBe("Resume");
  });

  it("flattens the punctuation a company name arrives with", () => {
    expect(resumeFileStem("Priya R", "Tata Consultancy Services Ltd.")).toBe(
      "Tata-Consultancy-Services-Ltd-Priya-R-Resume",
    );
    expect(resumeFileStem("Priya R", "Ernst & Young")).toBe("Ernst-Young-Priya-R-Resume");
  });

  it("keeps a name written in another script", () => {
    // The header of the document says this; the filename should agree with it.
    // The Content-Disposition builder is what makes it transmissible.
    expect(resumeFileStem("महेंद्र सम्मेता", "Zoho")).toBe("Zoho-महेंद्र-सम्मेता-Resume");
  });

  it("never runs away with a pasted company description", () => {
    const stem = resumeFileStem(
      "Mahendhar Sammeta",
      "Amazon Development Centre India Private Limited Hyderabad Campus Building 4",
    );
    expect(stem.length).toBeLessThanOrEqual(80);
    // Cut between words, never through one.
    expect(stem.split("-").every((w) => w.length > 0)).toBe(true);
  });
});

describe("contentDisposition", () => {
  it("emits both an ASCII fallback and the real name", () => {
    const value = contentDisposition("attachment", "Zoho-Mahendhar-Sammeta-Resume.pdf");
    expect(value).toContain('attachment; filename="Zoho-Mahendhar-Sammeta-Resume.pdf"');
    expect(value).toContain("filename*=UTF-8''Zoho-Mahendhar-Sammeta-Resume.pdf");
  });

  it("does not lose a non-ASCII name to the fallback", () => {
    const value = contentDisposition("attachment", "महेंद्र-Resume.pdf");
    // The fallback drops the script it cannot carry, and must not collapse to
    // an empty or dangling filename when it does.
    expect(value).toContain('filename="-Resume.pdf"');
    // The real name survives, percent-encoded.
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent("महेंद्र-Resume.pdf")}`);
  });

  it("falls back to Resume when nothing ASCII survives", () => {
    expect(contentDisposition("inline", "महेंद्र")).toContain('filename="Resume"');
  });

  it("cannot be used to inject a second header or escape the quotes", () => {
    // Not reachable through resumeFileStem, which emits only letters, digits
    // and hyphens — this is the guard for the next caller.
    const value = contentDisposition("attachment", 'evil"; x=y\r\nSet-Cookie: a=b.pdf');
    expect(value).not.toContain("\r");
    expect(value).not.toContain("\n");
    expect(value.match(/"/g)).toHaveLength(2);
  });
});
