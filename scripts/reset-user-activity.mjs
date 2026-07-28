/**
 * Clear ONE user's job-search activity, keeping the account itself intact.
 *
 * The existing purge scripts are both all-or-nothing: purge-users deletes whole
 * accounts (and with them the admin role), purge-demo only knows how to spot
 * mock rows. Neither answers "give this account a clean dashboard and let me
 * watch the agent fill it again from scratch", which is what you want when
 * you're evaluating discovery rather than clearing out test accounts.
 *
 * DELETED (everything the dashboard renders as work done):
 *   applications (+ their events, cascade), browser tasks, submission receipts,
 *   agent runs, daily usage, daily reports, notifications, saved form answers,
 *   audit log rows.
 *
 * KEPT, deliberately:
 *   the user row and its role — an admin stays an admin
 *   profile + resume + resume versions — the agent searches FROM these. Wiping
 *     them doesn't reset the search, it disables it, and the account would have
 *     to walk onboarding again before it could find anything at all.
 *   integrations, platform credentials, extension tokens — connections, not
 *     activity. Reconnecting Internshala costs an OTP round trip.
 *   the global Job table — scraped listings belong to no user.
 *
 * Pass --wipe-resume to also drop resume text, versions and generated variants.
 * That one DOES require re-onboarding, so it is opt-in.
 *
 * Guard: refuses without CONFIRM_RESET=<email>, so a stray `docker compose run`
 * can never fire it.
 *
 * Run in prod:
 *   docker compose run --rm --no-deps -e CONFIRM_RESET=someone@example.com web \
 *     node scripts/reset-user-activity.mjs someone@example.com
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const email = (process.argv[2] || "").trim().toLowerCase();
const wipeResume = process.argv.slice(2).includes("--wipe-resume");

async function main() {
  if (!email || email.startsWith("--")) {
    console.error("usage: node scripts/reset-user-activity.mjs <email> [--wipe-resume]");
    process.exit(1);
  }
  if ((process.env.CONFIRM_RESET || "").trim().toLowerCase() !== email) {
    console.error(`REFUSING TO RUN — this permanently deletes ${email}'s application history.`);
    console.error(`Set CONFIRM_RESET=${email} to proceed.`);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No account for ${email}.`);
    process.exit(1);
  }
  const userId = user.id;
  console.log(`Resetting activity for ${email} (${userId}), role=${user.role}`);

  // Children before parents where no cascade exists; browser_tasks carries a
  // user_id and an application_id but declares neither as a relation, so nothing
  // would clean it up on its own.
  const steps = [
    ["browser tasks", () => prisma.browserTask.deleteMany({ where: { userId } })],
    ["submission receipts", () => prisma.submissionReceipt.deleteMany({ where: { userId } })],
    ["applications", () => prisma.application.deleteMany({ where: { userId } })],
    ["agent runs", () => prisma.agentRun.deleteMany({ where: { userId } })],
    ["daily usage", () => prisma.dailyUsage.deleteMany({ where: { userId } })],
    ["reports", () => prisma.report.deleteMany({ where: { userId } })],
    ["notifications", () => prisma.notification.deleteMany({ where: { userId } })],
    ["saved answers", () => prisma.userAnswer.deleteMany({ where: { userId } })],
    ["audit log rows", () => prisma.auditLog.deleteMany({ where: { userId } })],
  ];
  if (wipeResume) {
    steps.push(
      ["resume variants", () => prisma.resumeVariant.deleteMany({ where: { userId } })],
      ["resume versions", () => prisma.resumeVersion.deleteMany({ where: { userId } })],
    );
  }

  for (const [label, run] of steps) {
    const { count } = await run();
    console.log(`  ${label.padEnd(22)} ${count}`);
  }

  if (wipeResume) {
    await prisma.profile.updateMany({
      where: { userId },
      data: { resumeText: null, resumePath: null, skills: null },
    });
    console.log("  profile resume text     cleared (account must re-onboard)");
  }

  // The account keeps whatever role it had; re-asserting it here means a reset
  // can never be the thing that quietly demotes the only admin.
  if (user.role === "admin") {
    await prisma.user.update({ where: { id: userId }, data: { role: "admin" } });
    console.log("  admin role              preserved");
  }

  const left = await prisma.application.count({ where: { userId } });
  console.log(`Done. ${email} now has ${left} application(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
