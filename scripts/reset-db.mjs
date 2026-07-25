/**
 * Reset database to a clean slate.
 * Deletes all user data, logs, applications, etc.
 *
 * Guarded: requires --yes, and refuses to run against what looks like a
 * production database unless --force-prod is also passed. This script wiped
 * the DB with zero confirmation before — a stray `node scripts/reset-db.mjs`
 * against a sourced prod .env was a one-command outage.
 *
 * Run: node scripts/reset-db.mjs --yes
 */
import { PrismaClient } from "@prisma/client";
import fsp from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const forceProd = args.includes("--force-prod");

const rawUrl = process.env.DATABASE_URL || "";
// Redact credentials before printing.
const displayUrl = rawUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");

const looksLikeProd =
  process.env.NODE_ENV === "production" ||
  (rawUrl && !rawUrl.startsWith("file:") && !/localhost|127\.0\.0\.1|postgres:5432/.test(rawUrl));

console.log(`Target database: ${displayUrl || "(DATABASE_URL not set)"}`);

if (!confirmed) {
  console.error("\nRefusing to run: pass --yes to confirm you want to permanently delete ALL data.");
  console.error("  node scripts/reset-db.mjs --yes");
  process.exit(1);
}

if (looksLikeProd && !forceProd) {
  console.error("\nThis looks like a PRODUCTION database (NODE_ENV=production or a non-local DATABASE_URL).");
  console.error("Refusing to wipe it. If you are absolutely certain, re-run with --force-prod as well:");
  console.error("  node scripts/reset-db.mjs --yes --force-prod");
  process.exit(1);
}

const prisma = new PrismaClient();
const root = path.resolve(process.cwd());

const USER_DATA_DIRECTORIES = [
  path.join(root, "data", "resumes"),
  path.join(root, "data", "resume_tex"),
  path.join(root, "data", "resume_variants"),
  path.join(root, "data", "screenshots"),
  path.join(root, "data", "browser_profile"),
  path.join(root, "data", "logs"),
  // Legacy location used by older platform adapters; may contain live sessions.
  path.join(root, "agent", "browser_profile"),
];
const USER_DATA_FILES = [
  path.join(root, "data", "email-outbox.jsonl"),
  path.join(root, "data", "slack-outbox.jsonl"),
];

function assertWorkspaceTarget(target) {
  const resolved = path.resolve(target);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing unsafe cleanup target: ${resolved}`);
  }
  return resolved;
}

async function resetUserFiles() {
  console.log("\nClearing runtime user files...");
  for (const target of [...USER_DATA_DIRECTORIES, ...USER_DATA_FILES]) {
    const safeTarget = assertWorkspaceTarget(target);
    await fsp.rm(safeTarget, { recursive: true, force: true });
    console.log(`  deleted ${path.relative(root, safeTarget)}`);
  }

  // Recreate active storage roots so the first beta user's upload/log write
  // does not depend on a separate setup command.
  for (const target of USER_DATA_DIRECTORIES.filter(
    (entry) => !entry.endsWith(path.join("agent", "browser_profile")),
  )) {
    await fsp.mkdir(assertWorkspaceTarget(target), { recursive: true });
  }
}

async function resetDb() {
  console.log("Resetting database...");

  // Order matters — delete children before parents (FK constraints)
  const results = await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.userAnswer.deleteMany(),
    prisma.supportTicket.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.extensionToken.deleteMany(),
    prisma.report.deleteMany(),
    prisma.otpToken.deleteMany(),
    prisma.otpAttempt.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    prisma.rateLimitEntry.deleteMany(),
    prisma.agentRun.deleteMany(),
    prisma.platformCredential.deleteMany(),
    prisma.userIntegration.deleteMany(),
    prisma.application.deleteMany(),
    prisma.resumeVariant.deleteMany(),
    prisma.resumeVersion.deleteMany(),
    prisma.profile.deleteMany(),
    prisma.companyReputation.deleteMany(),
    prisma.job.deleteMany(),
    prisma.user.deleteMany(),
    prisma.backupHealth.deleteMany(),
    prisma.accessAllowlist.deleteMany(),
    prisma.pageView.deleteMany(),
  ]);

  const labels = [
    "audit_logs", "user_answers", "support_tickets", "notifications", "extension_tokens",
    "reports", "otp_tokens", "otp_attempts", "password_reset_tokens",
    "rate_limit_entries", "agent_runs", "platform_credentials",
    "user_integrations", "applications", "resume_variants",
    "resume_versions", "profiles", "company_reputation", "jobs", "users",
    "backup_health", "access_allowlist", "page_views",
  ];
  results.forEach((r, i) => console.log(`  deleted ${r.count} ${labels[i]}`));

  await resetUserFiles();
  console.log("\nDatabase is clean. Fresh start ready.");
  await prisma.$disconnect();
}

resetDb().catch((e) => { console.error(e); process.exit(1); });
