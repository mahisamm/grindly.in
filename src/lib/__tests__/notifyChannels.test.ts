import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { emailConfigured, slackConfigured, notifyChannels } from "@/lib/notifyChannels";

/**
 * Setup used to state "Daily reports go to your registered email automatically"
 * on a deploy with no mail server configured. The report was never lost — the
 * in-app bell is the worker's last fallback — but the user was pointed at an
 * inbox that would stay empty, which looks exactly like an agent that did
 * nothing. These tests pin the rule that decides what setup is allowed to offer.
 */
describe("report channels this deploy can deliver on", () => {
  const KEYS = ["EMAIL_SMTP_HOST", "EMAIL_SMTP_USER", "EMAIL_SMTP_PASS", "SLACK_BOT_TOKEN"];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("says no when nothing is configured", () => {
    expect(notifyChannels()).toEqual({ email: false, slack: false, inApp: true });
  });

  it("needs all three SMTP settings, not just a host", () => {
    // A half-configured mailer is a mailer that throws at send time, which is
    // worse than one that was never offered.
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    expect(emailConfigured()).toBe(false);
    process.env.EMAIL_SMTP_USER = "grindly";
    expect(emailConfigured()).toBe(false);
    process.env.EMAIL_SMTP_PASS = "secret";
    expect(emailConfigured()).toBe(true);
  });

  it("treats a blank setting as unset", () => {
    // Compose writes empty strings for variables absent from .env, so "" has to
    // read as missing or every deploy would claim it can send mail.
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_SMTP_USER = "   ";
    process.env.EMAIL_SMTP_PASS = "secret";
    expect(emailConfigured()).toBe(false);
  });

  it("reads Slack from the same variable the worker does", () => {
    expect(slackConfigured()).toBe(false);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    expect(slackConfigured()).toBe(true);
  });

  it("always offers the in-app bell", () => {
    // The one channel that needs no configuration and cannot be unreachable.
    expect(notifyChannels().inApp).toBe(true);
  });
});
