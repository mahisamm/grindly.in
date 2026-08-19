#!/usr/bin/env node
/**
 * One-command setup for a fresh clone. Idempotent — safe to re-run.
 *   npm run setup
 *
 * Does: ensure .env (+ generate APP_ENCRYPTION_KEY), npm install, install agent
 * Python deps + Playwright chromium, prisma generate + migrate deploy.
 */
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const run = (cmd, opts = {}) => {
  console.log(`\n\x1b[36m$ ${cmd}\x1b[0m`);
  execSync(cmd, { stdio: "inherit", cwd: root, ...opts });
};
const step = (n, m) => console.log(`\n\x1b[1m[${n}] ${m}\x1b[0m`);

// 1. .env
step(1, "Environment file");
const envPath = path.join(root, ".env");
if (!fs.existsSync(envPath)) {
  fs.copyFileSync(path.join(root, ".env.example"), envPath);
  console.log("  created .env from .env.example");
}
let env = fs.readFileSync(envPath, "utf8");
const m = env.match(/^APP_ENCRYPTION_KEY=(.*)$/m);
const cur = m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
if (!/^[0-9a-fA-F]{64}$/.test(cur)) {
  const k = crypto.randomBytes(32).toString("hex");
  env = m
    ? env.replace(/^APP_ENCRYPTION_KEY=.*$/m, `APP_ENCRYPTION_KEY=${k}`)
    : env + `\nAPP_ENCRYPTION_KEY=${k}\n`;
  fs.writeFileSync(envPath, env);
  console.log("  generated APP_ENCRYPTION_KEY");
} else {
  console.log("  APP_ENCRYPTION_KEY already set");
}
if (!/^DATABASE_URL=/m.test(env)) {
  fs.appendFileSync(envPath, `\nDATABASE_URL="file:./dev.db"\n`);
  console.log("  added default DATABASE_URL");
}

// resolve python
const pyMatch = env.match(/^PYTHON_BIN=(.*)$/m);
const py = (pyMatch && pyMatch[1].trim()) || process.env.PYTHON_BIN || "python";

// 2. node deps
step(2, "Node dependencies");
run("npm install");

// 3. python deps + playwright
step(3, "Agent Python dependencies");
try {
  run(`${py} -m pip install -r agent/requirements.txt`);
  run(`${py} -m playwright install chromium`);
} catch {
  console.log("\x1b[33m  Python/Playwright install failed — install Python 3.10+ and re-run, or set PYTHON_BIN.\x1b[0m");
}

// 4. prisma
step(4, "Database");
run("npx prisma generate");
// `migrate deploy` rather than `db push`: a developer's database is then
// built by exactly the SQL that will build production, so a migration that
// is wrong is wrong on the first machine that runs it rather than on the
// last one.
run("npx prisma migrate deploy");

console.log("\n\x1b[32mSetup complete.\x1b[0m  Next: `npm run dev`  →  http://localhost:3000\n");
