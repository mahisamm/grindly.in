import { describe, expect, it } from "vitest";
import { likelyStartYear } from "@/lib/proffQuestions";

/**
 * Working out when a degree started, from the course and its end year.
 *
 * The split that makes this safe: how long a B.Tech runs is a fact about the
 * QUALIFICATION and can be looked up; whether this candidate took four years is
 * a fact about the PERSON and cannot. Lateral entry from a diploma skips a
 * year, and a gap year, a transfer or a repeated year each move it.
 *
 * So the answer is prefilled into setup with a "worked out — check it" badge
 * and confirmed by the student, never written silently onto an employer's form.
 * Returning null leaves the question asked normally, which is the honest
 * outcome when it cannot be worked out at all.
 */
describe("likelyStartYear", () => {
  it("works out a B.Tech from its graduation year", () => {
    // The case the owner asked for: graduating 2027, four-year course.
    expect(likelyStartYear("B.Tech", 2027)).toBe(2023);
  });

  it("knows how long each course actually runs", () => {
    expect(likelyStartYear("B.E.", 2027)).toBe(2023);   // 4
    expect(likelyStartYear("BCA", 2027)).toBe(2024);    // 3
    expect(likelyStartYear("B.Sc", 2026)).toBe(2023);   // 3
    expect(likelyStartYear("MBA", 2026)).toBe(2024);    // 2
    expect(likelyStartYear("M.Tech", 2026)).toBe(2024); // 2
    expect(likelyStartYear("MBBS", 2028)).toBe(2023);   // 5
  });

  it("says nothing when the course is unknown", () => {
    // A degree we have no length for must leave the question asked, not
    // answered with an invented number.
    expect(likelyStartYear("PhD", 2027)).toBeNull();
    expect(likelyStartYear("Something else", 2027)).toBeNull();
    expect(likelyStartYear("", 2027)).toBeNull();
    expect(likelyStartYear(null, 2027)).toBeNull();
  });

  it("says nothing without a usable graduation year", () => {
    expect(likelyStartYear("B.Tech", 0)).toBeNull();
    expect(likelyStartYear("B.Tech", null)).toBeNull();
    expect(likelyStartYear("B.Tech", "")).toBeNull();
    expect(likelyStartYear("B.Tech", "not a year")).toBeNull();
  });

  it("rejects a year outside anything a student could have", () => {
    expect(likelyStartYear("B.Tech", 1492)).toBeNull();
    expect(likelyStartYear("B.Tech", 3000)).toBeNull();
  });

  it("accepts a year given as a string, which is how a select returns it", () => {
    expect(likelyStartYear("B.Tech", "2027")).toBe(2023);
  });
});
