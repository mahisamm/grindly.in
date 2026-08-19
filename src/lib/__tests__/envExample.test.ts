import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * `.env.example` is committed. A real key pasted into it is published.
 *
 * This is not hypothetical: on 20 Aug 2026 a live Cerebras key was sitting on
 * line 34 of the working copy, one `git add -A` from being in the repository
 * forever. It was caught by reading the file for an unrelated reason. Nothing
 * would have caught it otherwise — the template is not linted, not typechecked
 * and not imported by anything, so no tool in this project had ever looked at
 * its contents.
 *
 * The rule is simple enough to hold: in a TEMPLATE, every key variable is empty.
 * A value in one of them is either a real credential or a placeholder that
 * teaches someone to leave a real credential there.
 */
const KEY_SHAPES = [
  /sk-or-v1-[A-Za-z0-9]{16,}/, // OpenRouter
  /csk-[a-z0-9]{16,}/, // Cerebras
  /gsk_[A-Za-z0-9]{16,}/, // Groq
  /AIza[A-Za-z0-9_-]{16,}/, // Google
  /xai-[A-Za-z0-9]{16,}/, // xAI
  /sk-ant-[A-Za-z0-9-]{16,}/, // Anthropic
  /rzp_(live|test)_[A-Za-z0-9]{10,}/, // Razorpay
  /gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
];

describe(".env.example", () => {
  const file = path.join(process.cwd(), ".env.example");
  const text = fs.readFileSync(file, "utf8");

  it("contains no value shaped like a real credential", () => {
    for (const shape of KEY_SHAPES) {
      const hit = text.match(shape);
      expect(
        hit,
        `.env.example looks like it contains a real credential (${shape}). ` +
          `Empty the value, and revoke the key — a committed template is public.`,
      ).toBeNull();
    }
  });

  it("leaves every *_KEY, *_SECRET and *_TOKEN variable empty", () => {
    const offenders = text
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.match(/^([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD))=(.*)$/))
      .filter((m): m is RegExpMatchArray => Boolean(m))
      // A human-written placeholder is fine; an opaque string is not. The test
      // is whether it reads as WORDS: every hyphen- or underscore-separated
      // segment must be alphabetic and short. `change_me_in_production` passes.
      // `csk-dpd9ptx5dk8hnc32kn52ytm58ednhcww62hnde258vrnyf5h` does not, and
      // neither does any other credential this project has ever issued.
      .filter(([, , raw]) => {
        const value = raw.trim().replace(/^["']|["']$/g, "");
        if (value.length <= 12) return false;
        return !value
          .split(/[-_]/)
          .every((part) => part.length > 0 && part.length <= 14 && /^[A-Za-z]+$/.test(part));
      })
      .map(([, name]) => name);
    expect(offenders, `these are filled in: ${offenders.join(", ")}`).toEqual([]);
  });
});
