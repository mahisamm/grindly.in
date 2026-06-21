#!/usr/bin/env node
/**
 * Preflight — fail fast with a human message if the machine isn't ready to run
 * NexPath. Run by `npm run preflight` and automatically before `npm run dev`.
 *
 * Checks: .env present, APP_ENCRYPTION_KEY valid, DATABASE_URL set, Python
 * available, Playwright + chromium installed, agent deps importable.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
let hard = 0;
let soft = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); hard++; };
const warn = (m) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); soft++; };

// ---- parse .env (Next loads it at runtime; this script needs it standalone) ----
function readEnv() {
  const out = {};
  for (const f of [".env", ".env.local"]) {
    const p = path.join(root, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return { ...out, ...process.env };
}

console.log("\nNexPath preflight\n");

const envFile = fs.existsSync(path.join(root, ".env"));
if (envFile) ok(".env present"); else bad(".env missing — run: cp .env.example .env  (then `npm run setup`)");

const env = readEnv();

if (!env.DATABASE_URL) bad("DATABASE_URL not set in .env");
else ok(`DATABASE_URL = ${env.DATABASE_URL}`);

const key = env.APP_ENCRYPTION_KEY || "";
if (!/^[0-9a-fA-F]{64}$/.test(key)) {
  bad("APP_ENCRYPTION_KEY missing or not 64 hex chars — connecting platforms will fail. Run `npm run setup`.");
} else ok("APP_ENCRYPTION_KEY valid (64 hex)");

const py = env.PYTHON_BIN || "python";
let pyOk = false;
try {
  const v = execSync(`${py} --version`, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  ok(`Python: ${v} (PYTHON_BIN=${py})`);
  pyOk = true;
} catch {
  bad(`Python not found via PYTHON_BIN="${py}". Install Python 3.10+ or set PYTHON_BIN to its path.`);
}

if (pyOk) {
  try {
    execSync(`${py} -c "import playwright"`, { stdio: "ignore" });
    ok("Playwright (python) installed");
    try {
      execSync(`${py} -m playwright install --dry-run chromium`, { stdio: "ignore" });
      ok("Playwright chromium present");
    } catch {
      warn("Playwright chromium may be missing — run: " + py + " -m playwright install chromium");
    }
  } catch {
    bad(`Playwright not installed for ${py}. Run \`npm run setup\` or: ${py} -m pip install -r agent/requirements.txt`);
  }
  // sanity: agent core modules import
  try {
    execSync(`${py} -c "import sys; sys.path.insert(0,'agent'); import db, matcher, safety"`, { stdio: "ignore" });
    ok("Agent core modules import");
  } catch {
    warn("Agent modules failed to import — check agent/requirements.txt is installed");
  }
}

console.log("");
if (hard) {
  console.log(`\x1b[31m${hard} blocking issue(s).\x1b[0m Fix the ✗ items above, then re-run.\n`);
  process.exit(1);
}
console.log(soft ? `\x1b[33mReady with ${soft} warning(s).\x1b[0m\n` : "\x1b[32mAll good — ready to run.\x1b[0m\n");
