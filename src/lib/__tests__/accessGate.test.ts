import { describe, expect, it } from "vitest";
import { isApproved } from "@/lib/auth";

/**
 * The beta door.
 *
 * One rule carries the whole thing and it is the one worth a test of its own:
 * an admin is never gated. The approval queue lives behind the admin surface,
 * so an admin who could be left `pending` would be locked out of the only
 * screen able to let them in — the account holding the key is the one account
 * that must never need it.
 */
describe("isApproved", () => {
  it("lets an approved account through", () => {
    expect(isApproved({ role: "user", accessStatus: "approved" })).toBe(true);
  });

  it("holds a pending account back", () => {
    expect(isApproved({ role: "user", accessStatus: "pending" })).toBe(false);
  });

  it("holds a blocked account back", () => {
    expect(isApproved({ role: "user", accessStatus: "blocked" })).toBe(false);
  });

  it("never gates an admin, whatever the column says", () => {
    for (const status of ["pending", "blocked", "approved", null, undefined, "nonsense"]) {
      expect(
        isApproved({ role: "admin", accessStatus: status as string }),
        `an admin was gated with accessStatus=${status}`,
      ).toBe(true);
    }
  });

  it("refuses an unknown status rather than assuming the best", () => {
    // A column that has drifted — a value written by a migration nobody
    // remembers — must read as "not yet", not as "come in".
    expect(isApproved({ role: "user", accessStatus: "APPROVED" })).toBe(false);
    expect(isApproved({ role: "user", accessStatus: "" })).toBe(false);
    expect(isApproved({ role: "user" })).toBe(false);
    expect(isApproved({})).toBe(false);
  });
});
