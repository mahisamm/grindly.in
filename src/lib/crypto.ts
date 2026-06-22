// Symmetric encryption for credentials/sessions stored at rest.
// AES-256-GCM. Wire format: `base64(nonce).base64(ciphertext||tag)` — byte-for-byte
// compatible with agent/secret_box.py (Python AESGCM), so either side can read
// what the other wrote. Key comes from APP_ENCRYPTION_KEY (64 hex chars = 32 bytes).
import crypto from "node:crypto";

function key(): Buffer {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || hex.length < 64) {
    throw new Error("APP_ENCRYPTION_KEY missing or too short (need 64 hex chars)");
  }
  return Buffer.from(hex.slice(0, 64), "hex");
}

export function encryptSecret(plain: string): string {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), nonce);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([ct, tag]);
  return `${nonce.toString("base64")}.${combined.toString("base64")}`;
}

export function decryptSecret(blob: string): string {
  const [n, c] = blob.split(".");
  if (!n || !c) throw new Error("malformed ciphertext");
  const nonce = Buffer.from(n, "base64");
  const combined = Buffer.from(c, "base64");
  const tag = combined.subarray(combined.length - 16);
  const ct = combined.subarray(0, combined.length - 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
