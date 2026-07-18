import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const SCRIPT = path.join(__dirname, "..", "preflight.mjs");

describe("preflight database validation", () => {
  it("rejects a SQLite URL when Prisma is configured for PostgreSQL", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "file:./dev.db", APP_ENCRYPTION_KEY: "a".repeat(64) },
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/must use postgresql:\/\/ or postgres:\/\//i);
  });

  it("does not print database credentials", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "postgresql://grindly:supersecret@localhost:5432/grindly", APP_ENCRYPTION_KEY: "a".repeat(64) },
      timeout: 20_000,
    });
    expect(result.stdout).not.toContain("supersecret");
  }, 25_000);
});
