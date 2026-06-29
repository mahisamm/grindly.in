import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { baseUrl } from "./baseUrl";

let SNAP: NodeJS.ProcessEnv;
beforeEach(() => {
  SNAP = { ...process.env };
  delete process.env.NEXT_PUBLIC_APP_URL;
  delete process.env.NEXT_PUBLIC_BASE_URL;
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SNAP)) delete process.env[k];
  Object.assign(process.env, SNAP);
});

describe("baseUrl resolution (M5)", () => {
  it("prefers NEXT_PUBLIC_APP_URL", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://app.example";
    process.env.NEXT_PUBLIC_BASE_URL = "https://base.example";
    expect(baseUrl("http://origin")).toBe("https://app.example");
  });

  it("falls back to NEXT_PUBLIC_BASE_URL", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://base.example";
    expect(baseUrl("http://origin")).toBe("https://base.example");
  });

  it("falls back to the request origin", () => {
    expect(baseUrl("http://origin")).toBe("http://origin");
  });

  it("falls back to localhost when nothing is set", () => {
    expect(baseUrl()).toBe("http://localhost:3000");
  });
});
