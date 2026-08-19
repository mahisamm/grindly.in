import { describe, expect, it } from "vitest";
import { pickPrimary } from "@/lib/primary";

/**
 * `User.primaryResumeId` is a pointer with no foreign key behind it, which is a
 * deliberate trade — see the schema comment — and the price of that trade is
 * that it may point at a row that is gone. Every case below is one this
 * resolver has to survive without the caller checking anything first.
 */
describe("pickPrimary", () => {
  const a = { id: "newest" };
  const b = { id: "older" };
  const list = [a, b]; // the page orders newest first

  it("returns the resume the pointer names", () => {
    expect(pickPrimary(list, "older")).toBe(b);
  });

  it("falls back to the newest resume when nothing is stored", () => {
    expect(pickPrimary(list, null)).toBe(a);
    expect(pickPrimary(list, undefined)).toBe(a);
    expect(pickPrimary(list, "")).toBe(a);
  });

  it("falls back when the pointer names a resume that is gone", () => {
    // The case with no foreign key to prevent it: the user deleted the resume
    // that was primary. This must resolve, not throw and not return undefined —
    // it is read on every load of the resume list.
    expect(pickPrimary(list, "deleted-months-ago")).toBe(a);
  });

  it("returns null for an account with no resumes at all", () => {
    expect(pickPrimary([], "anything")).toBeNull();
    expect(pickPrimary([], null)).toBeNull();
  });

  it("never picks a resume belonging to somebody else", () => {
    // The list handed in is always already scoped to one account, so a pointer
    // carrying an id from another account has no row to match and falls back.
    // This is the property that makes the missing foreign key safe rather than
    // merely convenient.
    expect(pickPrimary(list, "someone-elses-resume-id")).toBe(a);
  });
});
