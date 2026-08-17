import { describe, it, expect } from "vitest";
import { isValidEmail, normalizeEmail, validatePassword } from "@/lib/password";

/**
 * These helpers sit directly behind `await req.json()`, so their input is
 * whatever a client sent — an array, an object, a number, null. Typed as
 * `string` they compiled cleanly and threw at runtime: POSTing
 * `{"email": ["a@b.com"]}` to /api/auth/signup called `.trim()` on an array
 * and returned a 500 with a stack trace, on the endpoint a new user hits first.
 *
 * The rule they follow now is REJECT, not coerce. `String(["a@b.com"])` is
 * "a@b.com", so a coercing version would have accepted an array as an email
 * address — quietly wrong, which is worse than loudly wrong.
 */
const NOT_STRINGS: [string, unknown][] = [
  ["undefined", undefined],
  ["null", null],
  ["a number", 12345],
  ["a boolean", true],
  ["an array", ["a@b.com"]],
  ["an object", { toString: () => "a@b.com" }],
  ["a nested array", [["a@b.com"]]],
  ["an empty object", {}],
];

describe("normalizeEmail", () => {
  it.each(NOT_STRINGS)("returns an empty string for %s", (_label, value) => {
    expect(normalizeEmail(value)).toBe("");
  });

  it("trims and lowercases a real address", () => {
    expect(normalizeEmail("  Asha.Nair@Example.COM ")).toBe("asha.nair@example.com");
  });
});

describe("isValidEmail", () => {
  it.each(NOT_STRINGS)("rejects %s", (_label, value) => {
    expect(isValidEmail(value)).toBe(false);
  });

  it("rejects an object whose toString looks like an address", () => {
    // The specific shape that a coercing implementation would have let through.
    expect(isValidEmail({ toString: () => "real@example.com" })).toBe(false);
  });

  it.each([
    "asha@example.com",
    "asha.nair+jobs@example.co.in",
    "a@b.io",
  ])("accepts %s", (value) => {
    expect(isValidEmail(value)).toBe(true);
  });

  it.each([
    "",
    "no-at-sign",
    "two@@ats.com",
    "spaces in@example.com",
    "trailing@dot.",
    "a".repeat(250) + "@example.com",
  ])("rejects %s", (value) => {
    expect(isValidEmail(value)).toBe(false);
  });
});

describe("validatePassword", () => {
  it.each(NOT_STRINGS)("returns a message rather than throwing for %s", (_label, value) => {
    const problem = validatePassword(value);
    expect(typeof problem).toBe("string");
    expect(problem).toBeTruthy();
  });

  it("accepts a long ordinary passphrase", () => {
    expect(validatePassword("correcthorsebattery")).toBeNull();
  });

  it("rejects a short one", () => {
    expect(validatePassword("short")).toMatch(/at least/i);
  });

  it("rejects one that is absurdly long rather than hashing it", () => {
    // scrypt on a megabyte of input is a free CPU burn for anyone who asks.
    expect(validatePassword("p".repeat(10_000))).toBeTruthy();
  });

  it.each([
    "password123",
    "12345678901",
    // Ten characters exactly, top-twenty in every breach corpus, and it used to
    // pass: "qwerty" is a prefix of it but the suffix window stopped four
    // characters short.
    "qwertyuiop",
    // The shape a ten-character minimum actually produces from someone who
    // wanted to type "letmein".
    "letmein1234",
    "asdfghjkl123",
    "aaaaaaaaaa",
    "Passw0rd!!",
  ])("rejects %s", (p) => {
    expect(validatePassword(p)).toBeTruthy();
  });

  it("does not reject a real passphrase that opens with an ordinary word", () => {
    // The cost of widening the suffix window is here: these must survive.
    for (const p of [
      "welcome to the hotel california",
      "admin street market stall",
      "password shaped like a sentence",
    ]) {
      expect(validatePassword(p), p).toBeNull();
    }
  });
});
