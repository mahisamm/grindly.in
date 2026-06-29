import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { signSession, unsignSession } from "./sessionToken";

const KEY = "a".repeat(64);
let SNAP: NodeJS.ProcessEnv;
beforeEach(() => { SNAP = { ...process.env }; process.env.APP_ENCRYPTION_KEY = KEY; });
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in SNAP)) delete process.env[k];
  Object.assign(process.env, SNAP);
});

describe("session cookie sign/verify (H1)", () => {
  it("round-trips a uid", () => {
    expect(unsignSession(signSession("cuid_abc123"))).toBe("cuid_abc123");
  });

  it("rejects an unsigned raw uid (forged session)", () => {
    expect(unsignSession("cuid_abc123")).toBeNull();
  });

  it("rejects a tampered uid", () => {
    const v = signSession("cuid_abc123");
    const tampered = "evil" + v.slice(v.lastIndexOf("."));
    expect(unsignSession(tampered)).toBeNull();
  });

  it("rejects a tampered mac", () => {
    const v = signSession("cuid_abc123");
    expect(unsignSession(v.slice(0, v.lastIndexOf(".") + 1) + "deadbeef")).toBeNull();
  });

  it("rejects a value signed with a different secret", () => {
    const v = signSession("cuid_abc123");
    process.env.APP_ENCRYPTION_KEY = "b".repeat(64);
    expect(unsignSession(v)).toBeNull();
  });

  it("rejects empty / malformed values", () => {
    expect(unsignSession("")).toBeNull();
    expect(unsignSession(".")).toBeNull();
    expect(unsignSession(".abc")).toBeNull();
  });
});
