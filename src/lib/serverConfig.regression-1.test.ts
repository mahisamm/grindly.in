import { afterEach, describe, expect, it } from "vitest";
import { missingProdConfig } from "./serverConfig";

const original = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in original)) delete process.env[key];
  }
  Object.assign(process.env, original);
});

function configureCoreBetaServices() {
  process.env.DATABASE_URL = "postgresql://localhost/grindly";
  process.env.APP_ENCRYPTION_KEY = "a".repeat(64);
  process.env.GOOGLE_CLIENT_ID = "client";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  process.env.GOOGLE_OAUTH_BRAND_VERIFIED = "1";
  process.env.NEXT_PUBLIC_APP_URL = "https://beta.grindly.example";
  delete process.env.RAZORPAY_KEY_ID;
  delete process.env.RAZORPAY_KEY_SECRET;
}

describe("free-beta payment readiness regression", () => {
  it("does not require Razorpay while paid checkout is disabled", () => {
    configureCoreBetaServices();
    process.env.PAYMENTS_ENABLED = "false";

    expect(missingProdConfig()).toEqual([]);
  });

  it("requires Razorpay when paid checkout is explicitly enabled", () => {
    configureCoreBetaServices();
    process.env.PAYMENTS_ENABLED = "true";

    expect(missingProdConfig().join(" | ")).toMatch(/RAZORPAY/);
  });
});
