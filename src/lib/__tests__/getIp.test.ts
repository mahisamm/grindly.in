import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { getIp } from "@/lib/rateLimit";

/**
 * `getIp` decides whether an IP-keyed rate limit means anything at all.
 *
 * Two ways to get this wrong, and the codebase has now had both:
 *
 *   * Trust a client header without a proxy. Rotating one value then defeats
 *     every IP-keyed limit in the app.
 *   * Return a single constant for everyone. Every caller shares one bucket, so
 *     an attacker exhausting the login limit locks out the entire instance —
 *     an authentication denial of service that costs one script to trigger.
 *
 * The answer is `null` for "we genuinely do not know", and callers must skip
 * the IP-keyed limit rather than pretending a shared bucket is a limit.
 */

const ENV = { ...process.env };
beforeEach(() => { process.env = { ...ENV }; });
afterEach(() => { process.env = ENV; });

function req(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/auth/login", { method: "POST", headers });
}

describe("getIp without a trusted proxy", () => {
  it("returns null rather than a shared constant", () => {
    delete process.env.TRUST_PROXY;
    expect(getIp(req())).toBeNull();
  });

  it("ignores client-supplied forwarding headers", () => {
    delete process.env.TRUST_PROXY;
    // Both are trivially forgeable, so honouring either would make every
    // IP-keyed limit bypassable by rotating a header value.
    expect(getIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBeNull();
    expect(getIp(req({ "x-real-ip": "5.6.7.8" }))).toBeNull();
  });
});

describe("getIp behind a trusted proxy", () => {
  beforeEach(() => { process.env.TRUST_PROXY = "1"; });

  it("takes the LAST hop of x-forwarded-for", () => {
    // Caddy appends the real client IP rather than replacing the header, so the
    // first entry is still attacker-controlled. Taking it let anyone bypass
    // every IP-keyed limit by sending their own x-forwarded-for.
    expect(getIp(req({ "x-forwarded-for": "9.9.9.9, 1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("falls back to x-real-ip", () => {
    expect(getIp(req({ "x-real-ip": "5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("still returns null when the proxy sent nothing", () => {
    expect(getIp(req())).toBeNull();
  });
});
