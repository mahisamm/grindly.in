#!/usr/bin/env node
/**
 * Fail fast, with a human message, if this machine cannot run Grindly.
 *
 * Runs automatically before `npm run dev`. The rule it follows: a ✗ is something
 * that WILL break in the user's face, a ! is something that degrades. Getting
 * that line right is the whole value — a preflight that shouts about everything
 * teaches people to ignore it.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
let hard = 0;
let soft = 0;

const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); hard++; };
const warn = (m) => { console.log(`  \x1b[33m!\x1b[0m ${m}`); soft++; };

function readEnv() {
  const out = {};
  for (const file of [".env", ".env.local"]) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      if (line.trimStart().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  // A real environment variable always wins over the file.
  return { ...out, ...process.env };
}

console.log("\nGrindly preflight\n");

if (fs.existsSync(path.join(root, ".env"))) ok(".env present");
else bad(".env missing — run: cp .env.example .env && npm run setup");

const env = readEnv();

// ---- database ----
if (!env.DATABASE_URL) {
  bad("DATABASE_URL is not set");
} else if (!/^postgres(ql)?:\/\//i.test(env.DATABASE_URL)) {
  bad("DATABASE_URL must use postgresql:// or postgres:// — prisma/schema.prisma is PostgreSQL");
} else {
  try {
    const u = new URL(env.DATABASE_URL);
    ok(`DATABASE_URL → ${u.hostname}:${u.port || 5432}${u.pathname}`);
  } catch {
    bad("DATABASE_URL is not a valid connection URL");
  }
}

// ---- secrets ----
if (/^[0-9a-fA-F]{64}$/.test(env.APP_ENCRYPTION_KEY ?? "")) {
  ok("APP_ENCRYPTION_KEY is 64 hex characters");
} else {
  bad("APP_ENCRYPTION_KEY missing or malformed — sessions cannot be signed. Run `npm run setup`.");
}

// ---- python + the agent ----
//
// Skipped entirely when the configuration above is already broken. Probing the
// agent spawns an interpreter and imports Chromium's bindings, which is several
// seconds of work to answer a question that does not matter yet — nothing can
// run without a database and a signing key. Failing fast also keeps the output
// readable: three ✗ lines you can act on beat three ✗ lines buried under a
// dependency report.
if (hard) {
  console.log("");
  console.log(`\x1b[31m${hard} blocking issue(s).\x1b[0m Fix the ✗ lines above, then re-run.`);
  console.log("  (skipped the Python/renderer checks until the basics are set)\n");
  process.exit(1);
}

const py = env.PYTHON_BIN || "python";
let pythonOk = false;
try {
  const version = execFileSync(py, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
  ok(`Python: ${version}`);
  pythonOk = true;
} catch {
  bad(
    `Python not found at PYTHON_BIN="${py}". Every resume is read and rendered by ` +
      "agent/cli.py, so nothing works without it. Point PYTHON_BIN at the interpreter " +
      "that has agent/requirements.txt installed.",
  );
}

if (pythonOk) {
  // The agent reports on itself rather than being probed import by import — one
  // spawn, and it is the same code path the app uses, so a green line here means
  // the app's calls will work rather than merely that some imports resolve.
  try {
    const raw = execFileSync(py, [path.join(root, "agent", "cli.py")], {
      input: JSON.stringify({ cmd: "health" }),
      // Next loads .env before starting the app; this standalone probe must
      // pass the same parsed values to Python or it falsely reports that no
      // model provider is configured while the server sees one moments later.
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30_000,
    }).toString();
    const health = JSON.parse(raw);
    const c = health.checks ?? {};

    if (c.pdfminer && c.pypdf) ok("PDF extractors installed (pdfminer + pypdf)");
    else bad("PDF extraction is unavailable — run: " + py + " -m pip install -r agent/requirements.txt");

    if (c.docx) ok("DOCX extractor installed");
    else warn("python-docx missing — DOCX uploads will not be readable");

    if (c.renderer) {
      ok("Chromium renderer available");
    } else {
      bad(
        "Playwright/Chromium is missing, so no resume can be rebuilt into a PDF. Run: " +
          py + " -m playwright install chromium",
      );
    }

    if (Array.isArray(c.llm_providers) && c.llm_providers.length) {
      ok(`LLM providers configured: ${c.llm_providers.join(", ")}`);
    } else {
      warn(
        "No LLM key set. Scoring and the readiness report work fully without one — " +
          "rewrites and the written review do not.",
      );
    }
  } catch (e) {
    bad(`agent/cli.py could not run: ${String(e).slice(0, 200)}`);
  }
}

// ---- optional services ----
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) ok("Google sign-in configured");
else warn("No Google OAuth — email and password sign-in still works");

if (env.EMAIL_SMTP_HOST && env.EMAIL_SMTP_USER && env.EMAIL_SMTP_PASS) ok("SMTP configured");
else warn("No SMTP — outbound email is written to data/email-outbox.jsonl instead of sent");

if (String(env.PAYMENTS_ENABLED).toLowerCase() === "true") {
  if (env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) ok("Razorpay checkout is live");
  else bad("PAYMENTS_ENABLED=true but RAZORPAY_KEY_ID/SECRET are missing — checkout will fail");
} else {
  warn("Payments are in stub mode — passes are granted without money moving");
}

console.log("");
if (hard) {
  console.log(`\x1b[31m${hard} blocking issue(s).\x1b[0m Fix the ✗ lines above, then re-run.\n`);
  process.exit(1);
}
console.log(
  soft ? `\x1b[33mReady, with ${soft} warning(s).\x1b[0m\n` : "\x1b[32mAll good.\x1b[0m\n",
);
