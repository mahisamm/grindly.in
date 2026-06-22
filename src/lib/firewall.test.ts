// Unit tests for the apply firewall. Run with: npm i -D vitest && npx vitest run
// (Runner not bundled in the prototype — see ISSUES report.)
import { describe, it, expect } from "vitest";
import { canApply } from "./firewall";

describe("canApply firewall", () => {
  it("blocks excluded company (fuzzy)", () => {
    const r = canApply({ company: "Acme Corp Ltd" }, { excludedCompanies: '["Acme"]' });
    expect(r.ok).toBe(false);
  });

  it("blocks onsite job when user wants remote", () => {
    const r = canApply({ company: "X", location: "Bengaluru (Onsite)" }, { workMode: "remote" });
    expect(r.ok).toBe(false);
  });

  it("allows remote job when user wants remote", () => {
    const r = canApply({ company: "X", location: "Remote" }, { workMode: "remote" });
    expect(r.ok).toBe(true);
  });

  it("blocks stipend below floor", () => {
    const r = canApply({ company: "X", stipend: "₹5,000 /month" }, { stipendMin: 10000 });
    expect(r.ok).toBe(false);
  });

  it("blocks score below minimum", () => {
    const r = canApply({ company: "X", matchScore: 40 }, { minMatchScore: 55 });
    expect(r.ok).toBe(false);
  });

  it("allows a clean job", () => {
    const r = canApply(
      { company: "GoodCo", location: "Remote", stipend: "₹20000", matchScore: 80 },
      { excludedCompanies: '["BadCo"]', workMode: "remote", stipendMin: 10000, minMatchScore: 55 }
    );
    expect(r.ok).toBe(true);
  });
});
