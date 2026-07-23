import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  autoApplyMode,
  tierBEnabled,
  isEmployerChannel,
  agentWillSend,
  approvalOutcomeMessage,
} from "@/lib/applyPolicy";

// This is the web app's copy of the agent's apply policy. Its only job is to
// agree with agent/safety.py, because when it doesn't the product lies to the
// user in one of two directions: it promises a submission that never happens,
// or it tells someone to go finish an application the agent already sent.

const ENV = { ...process.env };

beforeEach(() => {
  delete process.env.GRINDLY_AUTO_APPLY_MODE;
  delete process.env.GRINDLY_TIER_B_APPLY;
});

afterEach(() => {
  process.env = { ...ENV };
});

const form = {
  applyChannel: "google_form",
  applyTier: "A",
  applyTarget: "https://docs.google.com/forms/d/e/X/viewform",
};
const mailbox = { applyChannel: "email", applyTier: "A", applyTarget: "careers@acme.in" };
const board = { applyChannel: "platform", applyTier: "C", applyTarget: "" };

describe("autoApplyMode", () => {
  it("defaults to shadow, not live", () => {
    expect(autoApplyMode()).toBe("shadow");
  });

  it("reads anything unrecognised as shadow", () => {
    for (const junk of ["LIVE!", "true", "1", "yes", "", "   "]) {
      process.env.GRINDLY_AUTO_APPLY_MODE = junk;
      expect(autoApplyMode()).toBe("shadow");
    }
  });

  it("accepts the three real modes, case-insensitively", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = " LIVE ";
    expect(autoApplyMode()).toBe("live");
    process.env.GRINDLY_AUTO_APPLY_MODE = "OFF";
    expect(autoApplyMode()).toBe("off");
    process.env.GRINDLY_AUTO_APPLY_MODE = "shadow";
    expect(autoApplyMode()).toBe("shadow");
  });
});

describe("tierBEnabled", () => {
  it("is off unless the exact flag is set", () => {
    expect(tierBEnabled()).toBe(false);
    process.env.GRINDLY_TIER_B_APPLY = "true";
    expect(tierBEnabled()).toBe(false);
    process.env.GRINDLY_TIER_B_APPLY = "1";
    expect(tierBEnabled()).toBe(true);
  });
});

describe("isEmployerChannel", () => {
  it("recognises an employer intake with a resolved target", () => {
    expect(isEmployerChannel(form)).toBe(true);
    expect(isEmployerChannel(mailbox)).toBe(true);
  });

  it("does NOT claim an ATS page is sendable — Tier A, but no sender exists yet", () => {
    const ats = { applyChannel: "ats", applyTier: "A", applyTarget: "https://jobs.lever.co/a/b" };
    expect(isEmployerChannel(ats)).toBe(false);
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    expect(agentWillSend(ats)).toBe(false);
    expect(approvalOutcomeMessage(ats)).toContain("your final browser submission");
  });

  it("rejects a board, and an employer channel with no target", () => {
    expect(isEmployerChannel(board)).toBe(false);
    expect(isEmployerChannel({ applyChannel: "google_form", applyTarget: "" })).toBe(false);
    expect(isEmployerChannel({})).toBe(false);
  });
});

describe("agentWillSend", () => {
  it("is false for everything in shadow mode — including Tier A", () => {
    expect(agentWillSend(form)).toBe(false);
    expect(agentWillSend(mailbox)).toBe(false);
    expect(agentWillSend(board)).toBe(false);
  });

  it("sends Tier A employer channels in live mode", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    expect(agentWillSend(form)).toBe(true);
    expect(agentWillSend(mailbox)).toBe(true);
  });

  it("never sends a Tier C board, at any setting", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    process.env.GRINDLY_TIER_B_APPLY = "1";
    expect(agentWillSend(board)).toBe(false);
  });

  it("needs the separate switch for Tier B", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    const tierB = { applyChannel: "platform", applyTier: "B", applyTarget: "" };
    expect(agentWillSend(tierB)).toBe(false);
    process.env.GRINDLY_TIER_B_APPLY = "1";
    expect(agentWillSend(tierB)).toBe(true);
  });

  it("is false in off mode", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "off";
    expect(agentWillSend(form)).toBe(false);
  });

  it("is false for a legacy row with no routing recorded", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    expect(agentWillSend({})).toBe(false);
    expect(agentWillSend({ applyChannel: null, applyTier: null, applyTarget: null })).toBe(false);
  });
});

describe("approvalOutcomeMessage", () => {
  it("says the user finishes it when the agent will not send", () => {
    expect(approvalOutcomeMessage(form)).toContain("your final browser submission");
  });

  it("names the mailbox when the agent will email it", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    expect(approvalOutcomeMessage(mailbox)).toContain("careers@acme.in");
  });

  it("says the agent submits the form when it will", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    expect(approvalOutcomeMessage(form)).toContain("the agent will submit");
  });
});
