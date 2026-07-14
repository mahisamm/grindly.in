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
  it("round-trips a uid + token version", () => {
    const claims = unsignSession(signSession("cuidabc123", 0));
    expect(claims).toEqual({ uid: "cuidabc123", tokenVersion: 0 });
  });

  it("preserves a non-zero token version", () => {
    const claims = unsignSession(signSession("cuidabc123", 7));
    expect(claims).toEqual({ uid: "cuidabc123", tokenVersion: 7 });
  });

  it("rejects an unsigned raw uid (forged session)", () => {
    expect(unsignSession("cuidabc123")).toBeNull();
  });

  it("rejects a tampered uid", () => {
    const v = signSession("cuidabc123", 0);
    const tampered = "evil" + v.slice(v.lastIndexOf("."));
    expect(unsignSession(tampered)).toBeNull();
  });

  it("rejects a tampered mac", () => {
    const v = signSession("cuidabc123", 0);
    expect(unsignSession(v.slice(0, v.lastIndexOf(".") + 1) + "deadbeef")).toBeNull();
  });

  it("rejects a value signed with a different secret", () => {
    const v = signSession("cuidabc123", 0);
    process.env.APP_ENCRYPTION_KEY = "b".repeat(64);
    expect(unsignSession(v)).toBeNull();
  });

  it("rejects a stale token beyond the max-age window", () => {
    const old = Date.now() - 60 * 60 * 24 * 31 * 1000; // 31 days ago
    expect(unsignSession(signSession("cuidabc123", 0, old))).toBeNull();
  });

  it("rejects empty / malformed values", () => {
    expect(unsignSession("")).toBeNull();
    expect(unsignSession(".")).toBeNull();
    expect(unsignSession(".abc")).toBeNull();
  });
});
