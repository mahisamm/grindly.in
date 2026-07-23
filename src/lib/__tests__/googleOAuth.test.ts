import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  gmailScanEnabled,
  gmailScanBeta,
  gmailScanBetaEmails,
  gmailSendEnabled,
  gmailScopes,
  gmailConnectBeta,
} from "@/lib/googleOAuth";

// gmailScanBeta is the per-user gate that keeps the live "Connect Gmail" flow
// away from the public while gmail.readonly is still in Google verification:
// only allowlisted testers (also added as Google test users) may reach consent.
// The two failure modes that matter: it must be OFF for everyone when the env
// switch is off (even allowlisted emails), and it must NEVER be on for an email
// outside the allowlist (that user would hit Google's "unverified app" wall).

const ENV = { ...process.env };

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "cid";
  process.env.GOOGLE_CLIENT_SECRET = "csec";
  process.env.GMAIL_SCAN_ENABLED = "1";
  process.env.GMAIL_SCAN_BETA_EMAILS = "owner@x.com, Tester@X.com";
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
});

afterEach(() => {
  process.env = { ...ENV };
});

describe("gmailScanBetaEmails", () => {
  it("parses a comma list, trims, and lowercases", () => {
    const s = gmailScanBetaEmails();
    expect(s.has("owner@x.com")).toBe(true);
    expect(s.has("tester@x.com")).toBe(true); // 'Tester@X.com' normalised
    expect(s.size).toBe(2);
  });

  it("is empty when the env var is unset", () => {
    delete process.env.GMAIL_SCAN_BETA_EMAILS;
    expect(gmailScanBetaEmails().size).toBe(0);
  });
});

describe("gmailScanBeta", () => {
  it("is true for an allowlisted email when the feature is enabled", () => {
    expect(gmailScanBeta("owner@x.com")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(gmailScanBeta("OWNER@X.com")).toBe(true);
    expect(gmailScanBeta("tester@x.com")).toBe(true);
  });

  it("is false for an email that is not on the allowlist", () => {
    expect(gmailScanBeta("random@student.com")).toBe(false);
  });

  it("is false when the env switch is off, even for an allowlisted email", () => {
    process.env.GMAIL_SCAN_ENABLED = "0";
    expect(gmailScanEnabled()).toBe(false);
    expect(gmailScanBeta("owner@x.com")).toBe(false);
  });

  it("is false for null/empty email", () => {
    expect(gmailScanBeta(null)).toBe(false);
    expect(gmailScanBeta(undefined)).toBe(false);
    expect(gmailScanBeta("")).toBe(false);
  });

  it("is false when no OAuth client is configured (gmailScanEnabled guards it)", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_ID;
    expect(gmailScanEnabled()).toBe(false);
    expect(gmailScanBeta("owner@x.com")).toBe(false);
  });
});

// gmail.send lets the agent mail an application from the user's own address —
// the lowest-risk delivery channel there is, and also the one with the worst
// failure mode if it turns on by accident. It is a separate switch from reading
// the inbox, and both are off unless the deploy says otherwise.

describe("gmailSendEnabled", () => {
  it("is off by default", () => {
    delete process.env.GMAIL_SEND_ENABLED;
    expect(gmailSendEnabled()).toBe(false);
  });

  it("is off for anything other than the exact flag", () => {
    for (const junk of ["true", "yes", "0", ""]) {
      process.env.GMAIL_SEND_ENABLED = junk;
      expect(gmailSendEnabled()).toBe(false);
    }
  });

  it("is on for the exact flag with a client configured", () => {
    process.env.GMAIL_SEND_ENABLED = "1";
    expect(gmailSendEnabled()).toBe(true);
  });

  it("is off with no OAuth client, whatever the flag says", () => {
    process.env.GMAIL_SEND_ENABLED = "1";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_ID;
    expect(gmailSendEnabled()).toBe(false);
  });

  it("does not turn on when only scanning is enabled", () => {
    process.env.GMAIL_SCAN_ENABLED = "1";
    delete process.env.GMAIL_SEND_ENABLED;
    expect(gmailScanEnabled()).toBe(true);
    expect(gmailSendEnabled()).toBe(false);
  });
});

describe("gmailScopes", () => {
  it("asks only for what is switched on", () => {
    delete process.env.GMAIL_SEND_ENABLED;
    expect(gmailScopes()).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  });

  it("asks for both in one consent when both are on", () => {
    process.env.GMAIL_SEND_ENABLED = "1";
    expect(gmailScopes()).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  it("asks for send alone when scanning is off", () => {
    process.env.GMAIL_SCAN_ENABLED = "0";
    process.env.GMAIL_SEND_ENABLED = "1";
    expect(gmailScopes()).toEqual(["https://www.googleapis.com/auth/gmail.send"]);
  });

  it("is empty when nothing is enabled — callers must not start the flow", () => {
    process.env.GMAIL_SCAN_ENABLED = "0";
    delete process.env.GMAIL_SEND_ENABLED;
    expect(gmailScopes()).toEqual([]);
  });
});

describe("gmailConnectBeta", () => {
  it("lets an allowlisted tester connect when either capability is on", () => {
    process.env.GMAIL_SCAN_ENABLED = "0";
    process.env.GMAIL_SEND_ENABLED = "1";
    expect(gmailConnectBeta("owner@x.com")).toBe(true);
  });

  it("still refuses anyone off the allowlist", () => {
    process.env.GMAIL_SEND_ENABLED = "1";
    expect(gmailConnectBeta("random@student.com")).toBe(false);
  });

  it("refuses everyone when both capabilities are off", () => {
    process.env.GMAIL_SCAN_ENABLED = "0";
    delete process.env.GMAIL_SEND_ENABLED;
    expect(gmailConnectBeta("owner@x.com")).toBe(false);
  });

  it("refuses null/empty email", () => {
    expect(gmailConnectBeta(null)).toBe(false);
    expect(gmailConnectBeta(undefined)).toBe(false);
    expect(gmailConnectBeta("")).toBe(false);
  });
});
