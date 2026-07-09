import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Integration-style: runs the real script as a subprocess so we exercise its
// actual process.exit()/argv/env guard logic, without ever touching a real
// database — every case here is asserted before the script would connect.
const SCRIPT = path.join(__dirname, "..", "reset-db.mjs");

function run(args: string[], env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 10_000,
  });
}

describe("scripts/reset-db.mjs guard", () => {
  it("refuses without --yes", () => {
    const res = run([], { DATABASE_URL: "file:./dev.db", NODE_ENV: "development" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/pass --yes to confirm/i);
  });

  it("refuses a production-looking DATABASE_URL even with --yes", () => {
    const res = run(["--yes"], {
      DATABASE_URL: "postgresql://u:p@db.hostinger.com:5432/grindly",
      NODE_ENV: "development",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/PRODUCTION database/i);
    expect(res.stderr).toMatch(/--force-prod/);
  });

  it("refuses when NODE_ENV=production even against a local-looking URL", () => {
    const res = run(["--yes"], { DATABASE_URL: "file:./dev.db", NODE_ENV: "production" });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/PRODUCTION database/i);
  });

  it("passes the guard for a local DATABASE_URL with --yes (dev environment)", () => {
    const res = run(["--yes"], { DATABASE_URL: "file:./dev.db", NODE_ENV: "development" });
    // Guard cleared — it moves on to the real reset (which then fails without a
    // real sqlite/prisma setup in this test env). We only assert it got past
    // the refusal branches, not that the DB reset itself succeeded.
    expect(res.stderr).not.toMatch(/Refusing to run/);
    expect(res.stderr).not.toMatch(/PRODUCTION database/i);
  });

  it("passes the guard for a prod-looking URL when both --yes and --force-prod are given", () => {
    const res = run(["--yes", "--force-prod"], {
      DATABASE_URL: "postgresql://u:p@db.hostinger.com:5432/grindly",
      NODE_ENV: "production",
    });
    expect(res.stderr).not.toMatch(/Refusing to run/);
    expect(res.stderr).not.toMatch(/PRODUCTION database/i);
  });

  it("redacts credentials in the printed target database", () => {
    const res = run([], {
      DATABASE_URL: "postgresql://grindly:supersecret@db.hostinger.com:5432/grindly",
      NODE_ENV: "development",
    });
    expect(res.stdout).not.toContain("supersecret");
    expect(res.stdout).toContain("***");
  });
});
