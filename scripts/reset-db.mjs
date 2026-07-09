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

async function resetDb() {
  console.log("Resetting database...");

  // Order matters — delete children before parents (FK constraints)
  const results = await prisma.$transaction([
    prisma.auditLog.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.report.deleteMany(),
    prisma.otpToken.deleteMany(),
    prisma.agentRun.deleteMany(),
    prisma.platformCredential.deleteMany(),
    prisma.userIntegration.deleteMany(),
    prisma.application.deleteMany(),
    prisma.resumeVersion.deleteMany(),
    prisma.profile.deleteMany(),
    prisma.job.deleteMany(),
    prisma.user.deleteMany(),
  ]);

  const labels = [
    "audit_logs", "notifications", "reports", "otp_tokens", "agent_runs",
    "platform_credentials", "user_integrations", "applications",
    "resume_versions", "profiles", "jobs", "users",
  ];
  results.forEach((r, i) => console.log(`  deleted ${r.count} ${labels[i]}`));

  console.log("\nDatabase is clean. Fresh start ready.");
  await prisma.$disconnect();
}

resetDb().catch((e) => { console.error(e); process.exit(1); });
