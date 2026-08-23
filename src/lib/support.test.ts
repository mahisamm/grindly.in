import { describe, expect, it } from "vitest";
import { TicketCategory, TicketStatus } from "@prisma/client";
import { SUPPORT_CATEGORIES, STATUS_LABEL, categoryLabel } from "./support";
import { SECTIONS, resolveSection } from "@/app/admin/Nav";

describe("support desk vocabulary", () => {
  it("offers exactly the ticket categories the schema knows", () => {
    // The picker, the admin list and the API all use SUPPORT_CATEGORIES; the
    // database uses the enum. A category in one and not the other is a ticket
    // the user can choose that the server refuses, or a row the UI cannot label.
    const ui = SUPPORT_CATEGORIES.map((c) => c.key).sort();
    const db = Object.values(TicketCategory).sort();
    expect(ui).toEqual(db);
  });

  it("labels every status on both sides", () => {
    for (const s of Object.values(TicketStatus)) {
      expect(STATUS_LABEL[s]).toBeTruthy();
    }
  });

  it("falls back to the raw key for an unknown category rather than crashing", () => {
    expect(categoryLabel("bug")).toBe("Something looks broken");
    expect(categoryLabel("nonsense" as TicketCategory)).toBe("nonsense");
  });
});

describe("admin sections", () => {
  it("resolves every old section name to a live one", () => {
    for (const legacy of ["overview", "access", "people", "quality", "money", "problems", "feedback", "health"]) {
      const target = resolveSection(legacy);
      expect(SECTIONS.some((s) => s.key === target)).toBe(true);
    }
    expect(resolveSection("overview")).toBe("dashboard");
    expect(resolveSection("health")).toBe("errors");
    expect(resolveSection(undefined)).toBe("dashboard");
    expect(resolveSection("garbage")).toBe("dashboard");
  });

  it("keeps current keys and legacy keys disjoint", () => {
    for (const s of SECTIONS) {
      // A current key must resolve to itself, never be re-routed by the map.
      expect(resolveSection(s.key)).toBe(s.key);
    }
  });
});
