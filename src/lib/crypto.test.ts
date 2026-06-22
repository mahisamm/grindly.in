import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY =
    "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
});

describe("crypto vault (AES-256-GCM)", () => {
  it("round-trips a secret", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    const blob = encryptSecret("hunter2-platform-password");
    expect(blob).toContain(".");
    expect(decryptSecret(blob)).toBe("hunter2-platform-password");
  });

  it("produces different ciphertext each time (random nonce)", async () => {
    const { encryptSecret } = await import("./crypto");
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("rejects tampered ciphertext", async () => {
    const { encryptSecret, decryptSecret } = await import("./crypto");
    const blob = encryptSecret("secret");
    const [n, c] = blob.split(".");
    const flipped = c.slice(0, -2) + (c.slice(-2) === "AA" ? "BB" : "AA");
    expect(() => decryptSecret(`${n}.${flipped}`)).toThrow();
  });
});
