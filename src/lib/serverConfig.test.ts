import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  databaseUrlConfigured, smsProvider, missingProdConfig, missingBetaAutomationConfig, paymentMode,
} from "./serverConfig";

const TOUCHED = [
  "FAST2SMS_API_KEY", "MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID", "MSG91_SENDER_ID",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_OAUTH_BRAND_VERIFIED", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET",
  "DATABASE_URL", "APP_ENCRYPTION_KEY", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_URL",
  "EMAIL_SMTP_HOST", "EMAIL_SMTP_USER",
  "GRINDLY_AUTO_APPLY_MODE", "GRINDLY_AUTOPILOT_ENABLED", "GRINDLY_DIRECT_SUBMIT_ENABLED",
  "GRINDLY_BROWSER_EXECUTOR_ENABLED", "GRINDLY_SEARCH_DISCOVERY_ENABLED", "GRINDLY_ATS_APPLY",
];
let SNAP: NodeJS.ProcessEnv;
beforeEach(() => {
  SNAP = { ...process.env };
  for (const k of TOUCHED) delete process.env[k];
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SNAP)) delete process.env[k];
  Object.assign(process.env, SNAP);
});

describe("smsProvider precedence", () => {
  it("null when nothing set", () => {
    expect(smsProvider()).toBeNull();
  });
  it("fast2sms wins over twilio", () => {
    process.env.FAST2SMS_API_KEY = "x";
    process.env.TWILIO_ACCOUNT_SID = "a";
    process.env.TWILIO_AUTH_TOKEN = "b";
    process.env.TWILIO_FROM_NUMBER = "c";
    expect(smsProvider()).toBe("fast2sms");
  });
  it("msg91 requires authkey + template + sender", () => {
    process.env.MSG91_AUTH_KEY = "x";
    expect(smsProvider()).toBeNull();
    process.env.MSG91_TEMPLATE_ID = "t";
    process.env.MSG91_SENDER_ID = "s";
    expect(smsProvider()).toBe("msg91");
  });
  it("twilio requires all three creds", () => {
    process.env.TWILIO_ACCOUNT_SID = "a";
    expect(smsProvider()).toBeNull();
    process.env.TWILIO_AUTH_TOKEN = "b";
    process.env.TWILIO_FROM_NUMBER = "c";
    expect(smsProvider()).toBe("twilio");
  });
});

describe("missingProdConfig — Google-only beta", () => {
  it("lists required production items when empty", () => {
    const m = missingProdConfig().join(" | ");
    expect(m).toMatch(/DATABASE_URL/);
    expect(m).toMatch(/APP_ENCRYPTION_KEY/);
    expect(m).toMatch(/GOOGLE/);
    expect(m).toMatch(/NEXT_PUBLIC_APP_URL/);
  });
  it("does NOT require SMS or SMTP (no phone OTP / no password reset)", () => {
    const m = missingProdConfig().join(" | ");
    expect(m).not.toMatch(/SMS/);
    expect(m).not.toMatch(/SMTP/);
  });
  it("is empty once the required set is present", () => {
    process.env.DATABASE_URL = "postgresql://x";
    process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "sec";
    process.env.GOOGLE_OAUTH_BRAND_VERIFIED = "1";
    process.env.NEXT_PUBLIC_APP_URL = "https://d";
    process.env.RAZORPAY_KEY_ID = "id";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    expect(missingProdConfig()).toEqual([]);
  });
  it("flags an APP_ENCRYPTION_KEY that isn't 64 hex", () => {
    process.env.DATABASE_URL = "postgresql://x";
    process.env.APP_ENCRYPTION_KEY = "tooshort";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "sec";
    process.env.GOOGLE_OAUTH_BRAND_VERIFIED = "1";
    process.env.NEXT_PUBLIC_APP_URL = "https://d";
    expect(missingProdConfig().join(" | ")).toMatch(/APP_ENCRYPTION_KEY/);
  });
});

describe("databaseUrlConfigured", () => {
  it("rejects SQLite because the Prisma schema is PostgreSQL", () => {
    process.env.DATABASE_URL = "file:./dev.db";
    expect(databaseUrlConfigured()).toBe(false);
    expect(missingProdConfig().join(" | ")).toMatch(/DATABASE_URL/);
  });
});

describe("paymentMode", () => {
  it("is unconfigured without both Razorpay keys", () => {
    expect(paymentMode()).toBe("unconfigured");
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    expect(paymentMode()).toBe("unconfigured");
  });
  it("razorpay when RAZORPAY_KEY_ID is set", () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_x";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    expect(paymentMode()).toBe("razorpay");
  });
});

describe("missingBetaAutomationConfig", () => {
  it("names every disabled beta automation dependency", () => {
    const missing = missingBetaAutomationConfig().join(" | ");
    expect(missing).toMatch(/AUTO_APPLY_MODE/);
    expect(missing).toMatch(/BROWSER_EXECUTOR/);
    expect(missing).toMatch(/SEARCH_DISCOVERY/);
    expect(missing).toMatch(/ATS_APPLY/);
    expect(missing).toMatch(/EMAIL_SMTP/);
  });

  it("is ready only when the full autonomous beta contract is configured", () => {
    process.env.GRINDLY_AUTO_APPLY_MODE = "live";
    process.env.GRINDLY_AUTOPILOT_ENABLED = "1";
    process.env.GRINDLY_DIRECT_SUBMIT_ENABLED = "1";
    process.env.GRINDLY_BROWSER_EXECUTOR_ENABLED = "1";
    process.env.GRINDLY_SEARCH_DISCOVERY_ENABLED = "1";
    process.env.GRINDLY_ATS_APPLY = "1";
    process.env.EMAIL_SMTP_HOST = "smtp.example.com";
    process.env.EMAIL_SMTP_USER = "beta";
    process.env.NEXT_PUBLIC_APP_URL = "https://beta.example.com";
    expect(missingBetaAutomationConfig()).toEqual([]);
  });
});
