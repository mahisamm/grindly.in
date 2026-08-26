import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..", "..");

describe("reset-user-data safety contract", () => {
  const script = fs.readFileSync(path.join(ROOT, "scripts", "reset-user-data.mjs"), "utf8");

  it("requires an explicit reset confirmation and refuses non-admin targets", () => {
    expect(script).toContain('flags.includes("--confirm-reset")');
    expect(script).toContain('user.role !== "admin"');
  });

  it("clears every user-linked store not handled solely by a resume cascade", () => {
    for (const model of [
      "pageView",
      "rateLimitEntry",
      "ticketMessage",
      "errorEvent",
      "ticket",
      "problemReport",
      "order",
      "dailyUsage",
      "passwordResetToken",
      "emailVerificationToken",
      "auditLog",
      "resume",
    ]) {
      expect(script).toContain(`tx.${model}.deleteMany`);
    }
  });

  it("retains the admin role while revoking existing sessions and clearing resume pointers", () => {
    expect(script).toContain('remaining.role !== "admin"');
    expect(script).toContain("tokenVersion: { increment: 1 }");
    expect(script).toContain("primaryResumeId: null");
    expect(script).toContain("freeCompanyRunId: null");
  });
});
