import { describe, expect, it } from "vitest";
import { safeReturnPath } from "@/lib/returnPath";

/**
 * `?next=` is attacker-controlled input on the sign-in page. The only shape it
 * may take is an absolute path on this origin; every way of smuggling another
 * host through it must fall back to the app home.
 */
describe("safeReturnPath", () => {
  it("keeps an ordinary same-origin path", () => {
    expect(safeReturnPath("/pricing")).toBe("/pricing");
    expect(safeReturnPath("/app/abc123?tab=rewrite")).toBe("/app/abc123?tab=rewrite");
  });

  it("falls back when there is nothing", () => {
    expect(safeReturnPath(null)).toBe("/app");
    expect(safeReturnPath(undefined)).toBe("/app");
    expect(safeReturnPath("")).toBe("/app");
    expect(safeReturnPath("", "/")).toBe("/");
  });

  it("refuses every way of naming another host", () => {
    // Each of these is a real open-redirect shape seen in the wild.
    for (const bad of [
      "https://evil.example/",
      "http://evil.example",
      "//evil.example",
      "/\\evil.example",
      "evil.example",
      "javascript:alert(1)",
      "/ok\r\nLocation: https://evil.example",
      "/" + "a".repeat(600),
    ]) {
      expect(safeReturnPath(bad), bad).toBe("/app");
    }
  });
});
