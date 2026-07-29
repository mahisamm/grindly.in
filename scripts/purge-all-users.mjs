/**
 * Delete EVERY user account, including the owner's. Irreversible.
 *
 * Different from purge-users.mjs, which keeps the admin: this is for starting
 * genuinely from zero — no accounts, no applications, no history — before
 * opening a beta. The owner signs in again afterwards and gets a brand new row.
 *
 * The dangerous part is not the deletion, it is what the deletion does to your
 * own way back in. Access is gated (lib/access.ts):
 *
 *   * `openSignups` is off, so a brand-new account resolves to "pending"
 *   * `ADMIN_EMAIL` is unset in production, so the owner exemption never fires
 *   * and after this runs there is no admin left to approve anybody
 *
 * Which means deleting yourself with no preparation locks you out of your own
 * app permanently. So this ALLOWLISTS the owner's email before deleting
 * anything — access_allowlist rows are not owned by a user and survive the
 * purge, and resolveInitialAccess() approves a match on sight. The role is a
 * separate matter: sign in, then `node scripts/make-admin.mjs <email>`.
 *
 * NOT touched:
 *   * Job — scraped listings are global, not user records, and throwing away a
 *     warm pool costs the next run an hour of scraping for no benefit.
 *   * error_events — crash reports about the software, not about a person.
 *   * OTP / rate-limit tables — keyed by phone and IP, and self-expiring.
 *
 * Everything hanging off User cascades (profile, applications, integrations,
 * credentials, resume versions, agent runs, notifications, reports, audit logs).
 * password_reset_tokens carries a user_id with no @relation, so Postgres will
 * not cascade it and it is deleted explicitly.
 *
 * Guard: refuses to run without CONFIRM_PURGE_ALL=DELETE-EVERY-USER.
 *
 *   docker compose run --rm -e CONFIRM_PURGE_ALL=DELETE-EVERY-USER web \
 *     node scripts/purge-all-users.mjs <owner-email>
 */
import { PrismaClient } from "@prisma/client";
import fsp from "fs/promises";
import path from "path";

const prisma = new PrismaClient();

const CONFIRM = "DELETE-EVERY-USER";

// The parts of a user that are not rows. Deleting the account and leaving their
// résumé PDF and a logged-in browser profile on disk is not "no record of
// users" — it is the same records, in the place nobody thinks to look.
const root = process.cwd();
const USER_FILE_DIRS = [
  "data/resumes",
  "data/resume_tex",
  "data/resume_variants",
  "data/screenshots",
  "data/browser_profile",
  "data/logs",
  // Legacy location used by older platform adapters; may hold live sessions.
  "agent/browser_profile",
];
const USER_FILES = ["data/email-outbox.jsonl", "data/slack-outbox.jsonl"];

/** Never let a bad join hand `rm -rf` something outside the workspace. */
function safeTarget(rel) {
  const resolved = path.resolve(root, rel);
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing unsafe cleanup target: ${resolved}`);
  }
  return resolved;
}

async function clearUserFiles() {
  console.log("\nClearing user files on disk:");
  for (const rel of [...USER_FILE_DIRS, ...USER_FILES]) {
    try {
      await fsp.rm(safeTarget(rel), { recursive: true, force: true });
      console.log(`  removed ${rel}`);
    } catch (e) {
      console.error(`  could not remove ${rel}: ${e.message}`);
    }
  }
  // Recreate the storage roots so the first new upload does not depend on a
  // separate setup step.
  for (const rel of USER_FILE_DIRS.filter((d) => !d.endsWith("browser_profile"))) {
    await fsp.mkdir(safeTarget(rel), { recursive: true }).catch(() => {});
  }
}

async function main() {
  if (process.env.CONFIRM_PURGE_ALL !== CONFIRM) {
    console.error("REFUSING TO RUN — this deletes EVERY user account, including yours.");
    console.error(`Set CONFIRM_PURGE_ALL=${CONFIRM} to proceed.`);
    process.exit(1);
  }

  const owner = (process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  if (!owner || !owner.includes("@")) {
    console.error("REFUSING TO RUN — pass the owner's email as the first argument.");
    console.error("Without it there is no allowlist entry and no way back into the app.");
    process.exit(1);
  }

  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  console.log(`About to delete ${users.length} user account(s):`);
  for (const u of users) console.log(`  - ${u.email} (${u.role})`);

  // Before anything is destroyed, guarantee the way back in. If this fails the
  // purge must not happen: an unreachable app is worse than a dirty one.
  await prisma.accessAllowlist.upsert({
    where: { email: owner },
    create: { email: owner, note: "owner — auto-approve after full purge" },
    update: { note: "owner — auto-approve after full purge" },
  });
  console.log(`\nallowlisted ${owner} — a fresh sign-in will be approved on sight`);

  const tokens = await prisma.passwordResetToken.deleteMany({});
  console.log(`password reset tokens removed: ${tokens.count}`);

  const deleted = await prisma.user.deleteMany({});
  console.log(`users removed: ${deleted.count} (profiles, applications, resumes, runs, reports and audit logs cascade)`);

  const left = await prisma.user.count();
  if (left !== 0) {
    console.error(`FAILED — ${left} user(s) still present.`);
    process.exit(1);
  }

  await clearUserFiles();

  console.log("\nDone. No user accounts remain.");
  console.log(`Next: sign in at the site with ${owner}, then run`);
  console.log(`  docker compose run --rm web node scripts/make-admin.mjs ${owner}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
