/**
 * Reset database to a clean slate.
 * Deletes all user data, logs, applications, etc.
 * Run: node scripts/reset-db.mjs
 */
import { PrismaClient } from "@prisma/client";

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
