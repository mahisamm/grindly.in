import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SCRIPT = path.join(__dirname, "..", "preflight.mjs");

describe("preflight database validation", () => {
  it("passes parsed .env values to the agent health probe", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toMatch(/execFileSync\(py,[\s\S]*?\{[\s\S]*?\benv,\s*\n[\s\S]*?stdio:/);
  });

  it("rejects a SQLite URL when Prisma is configured for PostgreSQL", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      cwd: path.join(__dirname, "..", ".."),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: "file:./dev.db", APP_ENCRYPTION_KEY: "a".repeat(64) },
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/must use postgresql:\/\/ or postgres:\/\//i);
  }, 25_000);

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
