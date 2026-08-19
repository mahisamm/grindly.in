#!/usr/bin/env node
/**
 * Wipe every row in the development database.
 *
 *   node scripts/reset-db.mjs --yes
 *   node scripts/reset-db.mjs --yes --force-prod    # only if you truly mean it
 *
 * Two test files hold this script to its contract, and both guard failures that
 * are silent rather than loud:
 *
 *   reset-db.test.ts — the refusal guards. A "reset the database" script is one
 *   mistyped env var away from being a "delete production" script, so it refuses
 *   by default, refuses harder when the URL or NODE_ENV looks like production,
 *   and prints its target with the password redacted so nobody pastes a live
 *   credential into a bug report.
 *
 *   reset-db.regression-1.test.ts — reads this file and asserts every model in
 *   schema.prisma has a `deleteMany()` below. Add a model, forget this file, and
 *   "reset" silently leaves rows behind; the next run starts from a state nobody
 *   intended and the resulting flake looks like anything except a missing line.
 */
import { PrismaClient } from "@prisma/client";

const args = new Set(process.argv.slice(2));
const confirmed = args.has("--yes");
const forceProd = args.has("--force-prod");

const url = process.env.DATABASE_URL ?? "";

/** Never print a live password, not even into a terminal someone screenshots. */
function redact(value) {
  return value.replace(/\/\/([^:/@]+):([^@]*)@/, "//$1:***@");
}

// Printed before any guard runs, so even a refusal tells you which database it
// was protecting. stdout, because it is information rather than an error.
console.log(`Target database: ${redact(url) || "(DATABASE_URL not set)"}`);

const looksLocal = /(^file:)|@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url);
const looksProd = process.env.NODE_ENV === "production" || !looksLocal;

if (!confirmed) {
  console.error("Refusing to run: pass --yes to confirm you want every row deleted.");
  process.exit(1);
}

if (looksProd && !forceProd) {
  console.error(
    "Refusing to run: this looks like a PRODUCTION database " +
      `(NODE_ENV=${process.env.NODE_ENV ?? "unset"}, host is not local).\n` +
      "If you are certain, re-run with --force-prod.",
  );
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  // Children before parents. Cascades would handle it, but a failure halfway
  // through then leaves a consistent database rather than parents whose
  // children are already gone.
  await prisma.variant.deleteMany();
  await prisma.target.deleteMany();
  await prisma.resume.deleteMany();
  await prisma.order.deleteMany();
  await prisma.dailyUsage.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();

  // Standalone tables, no relations to respect.
  await prisma.rateLimitEntry.deleteMany();
  await prisma.errorEvent.deleteMany();
  // Written by scripts/backup-drill.sh rather than by the app, and cleared here
  // anyway: "reset" has to mean the database is empty, or a drill result from
  // before the reset is read afterwards as if it described the new state.
  await prisma.backupHealth.deleteMany();

  console.log("Database reset.");
}

main()
  .catch((e) => {
    console.error(e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
