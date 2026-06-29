import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { smsProvider, missingProdConfig, paymentMode } from "./serverConfig";

const TOUCHED = [
  "FAST2SMS_API_KEY", "MSG91_AUTH_KEY", "MSG91_TEMPLATE_ID", "MSG91_SENDER_ID",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "STRIPE_SECRET_KEY",
  "DATABASE_URL", "APP_ENCRYPTION_KEY", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_BASE_URL",
  "EMAIL_SMTP_HOST", "EMAIL_SMTP_USER",
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
  it("lists the 4 required items when empty", () => {
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
    process.env.NEXT_PUBLIC_APP_URL = "https://d";
    expect(missingProdConfig()).toEqual([]);
  });
  it("flags an APP_ENCRYPTION_KEY that isn't 64 hex", () => {
    process.env.DATABASE_URL = "postgresql://x";
    process.env.APP_ENCRYPTION_KEY = "tooshort";
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "sec";
    process.env.NEXT_PUBLIC_APP_URL = "https://d";
    expect(missingProdConfig().join(" | ")).toMatch(/APP_ENCRYPTION_KEY/);
  });
});

describe("paymentMode", () => {
  it("stub without a Stripe key", () => {
    expect(paymentMode()).toBe("stub");
  });
  it("stripe when STRIPE_SECRET_KEY is set", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    expect(paymentMode()).toBe("stripe");
  });
});
