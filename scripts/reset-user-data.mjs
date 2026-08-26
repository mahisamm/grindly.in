#!/usr/bin/env node
/**
 * Reset one ADMIN account to a newly-created state without removing its login
 * identity or operator access.
 *
 * Usage:
 *   node scripts/reset-user-data.mjs person@example.com --dry-run
 *   node scripts/reset-user-data.mjs person@example.com --confirm-reset
 *
 * This intentionally refuses non-admin accounts. Account deletion is already
 * available in the product; this tool exists for the narrower operator case:
 * erase one operator's personal content while retaining the one account that
 * can administer the service. It is safe to re-run after a partial file
 * cleanup: database work is transactional and file removals are idempotent.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const [email, ...flags] = process.argv.slice(2);
const dryRun = flags.includes("--dry-run");
const confirmed = flags.includes("--confirm-reset");

if (!email || !email.includes("@") || (!dryRun && !confirmed)) {
  console.error(
    "Usage: node scripts/reset-user-data.mjs <exact-email> --dry-run | --confirm-reset",
  );
  process.exit(1);
}

const prisma = new PrismaClient();
const dataDir = path.join(process.cwd(), "data");
const resumeDir = path.join(dataDir, "resumes");
const variantDir = path.join(dataDir, "variants");

function lineMentionsUser(line, user) {
  return line.includes(user.id) || line.toLowerCase().includes(user.email.toLowerCase());
}

async function removeOutboxEntries(user) {
  const outbox = path.join(dataDir, "email-outbox.jsonl");
  let content;
  try {
    content = await fs.readFile(outbox, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return 0;
    throw error;
  }

  const lines = content.split(/\r?\n/);
  const kept = lines.filter((line) => line && !lineMentionsUser(line, user));
  const removed = lines.filter((line) => line && lineMentionsUser(line, user)).length;
  if (removed) await fs.writeFile(outbox, `${kept.join("\n")}\n`, "utf8");
  return removed;
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true },
  });
  if (!user) throw new Error("No account found for that email.");
  if (user.role !== "admin") {
    throw new Error("Refusing: this tool only resets an existing admin account.");
  }

  const resumes = await prisma.resume.findMany({
    where: { userId: user.id },
    select: { id: true, ext: true },
  });
  const [usage, orders, tickets, problems, pageViews, rateLimits, authoredMessages, matchingErrors] =
    await Promise.all([
      prisma.dailyUsage.count({ where: { userId: user.id } }),
      prisma.order.count({ where: { userId: user.id } }),
      prisma.ticket.count({ where: { userId: user.id } }),
      prisma.problemReport.count({ where: { userId: user.id } }),
      prisma.pageView.count({ where: { userId: user.id } }),
      prisma.rateLimitEntry.count({
        where: {
          OR: [
            { key: { contains: user.id } },
            { key: { contains: user.email, mode: "insensitive" } },
          ],
        },
      }),
      prisma.ticketMessage.count({ where: { authorId: user.id } }),
      prisma.errorEvent.count({
        where: {
          OR: [
            { context: { contains: user.id } },
            { context: { contains: user.email, mode: "insensitive" } },
            { message: { contains: user.email, mode: "insensitive" } },
            { stack: { contains: user.email, mode: "insensitive" } },
          ],
        },
      }),
    ]);

  const summary = {
    resumes: resumes.length,
    usage,
    orders,
    tickets,
    problems,
    pageViews,
    rateLimits,
    authoredMessages,
    matchingErrors,
  };
  console.log(`${dryRun ? "Would reset" : "Resetting"} admin account data:`, summary);
  if (dryRun) return;

  await prisma.$transaction(async (tx) => {
    // These have no User foreign key, so account-level cascade cannot reach them.
    await tx.pageView.deleteMany({ where: { userId: user.id } });
    await tx.rateLimitEntry.deleteMany({
      where: {
        OR: [
          { key: { contains: user.id } },
          { key: { contains: user.email, mode: "insensitive" } },
        ],
      },
    });
    await tx.ticketMessage.deleteMany({ where: { authorId: user.id } });
    await tx.errorEvent.deleteMany({
      where: {
        OR: [
          { context: { contains: user.id } },
          { context: { contains: user.email, mode: "insensitive" } },
          { message: { contains: user.email, mode: "insensitive" } },
          { stack: { contains: user.email, mode: "insensitive" } },
        ],
      },
    });

    // User-owned relations cascade through these deletions. Delete in this
    // order so application, variant, score, run and target relations are
    // deterministically cleared even if a future schema changes a cascade.
    await tx.ticket.deleteMany({ where: { userId: user.id } });
    await tx.problemReport.deleteMany({ where: { userId: user.id } });
    await tx.order.deleteMany({ where: { userId: user.id } });
    await tx.dailyUsage.deleteMany({ where: { userId: user.id } });
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id } });
    await tx.emailVerificationToken.deleteMany({ where: { userId: user.id } });
    await tx.auditLog.deleteMany({ where: { userId: user.id } });
    await tx.resume.deleteMany({ where: { userId: user.id } });

    // Keep only credentials and the admin identity. Incrementing tokenVersion
    // signs out every old browser session, so the reset is also fresh in use.
    await tx.user.update({
      where: { id: user.id },
      data: {
        name: null,
        plan: "free",
        planExpiresAt: null,
        accessStatus: "approved",
        approvedBy: null,
        approvedAt: new Date(),
        emailVerifiedAt: null,
        primaryResumeId: null,
        freeCompanyRunId: null,
        timezone: null,
        deletedAt: null,
        tokenVersion: { increment: 1 },
      },
    });
  });

  // Files happen after the committed rows. Failure here leaves only safe,
  // unreachable bytes and this command can be re-run to finish their removal.
  for (const resume of resumes) {
    if (resume.ext) {
      await fs.rm(path.join(resumeDir, `${resume.id}${resume.ext}`), { force: true });
    }
    await fs.rm(path.join(variantDir, resume.id), { recursive: true, force: true });
  }
  const outboxEntries = await removeOutboxEntries(user);

  const remaining = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { role: true, name: true, primaryResumeId: true, freeCompanyRunId: true },
  });
  if (
    remaining.role !== "admin" ||
    remaining.name !== null ||
    remaining.primaryResumeId !== null ||
    remaining.freeCompanyRunId !== null
  ) {
    throw new Error("Reset verification failed: the account did not reach the fresh admin state.");
  }
  console.log(`Reset complete. Removed ${resumes.length} resume directory/directories and ${outboxEntries} outbox entry/entries.`);
}

main()
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
