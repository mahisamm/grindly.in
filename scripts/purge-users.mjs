/**
 * Wipe EVERY user account and all data owned by them. Irreversible.
 *
 * Intended for one thing: clearing out beta/test accounts before opening signups
 * to real users. It is not a maintenance script — there is no undo.
 *
 * Everything hanging off User has onDelete: Cascade in schema.prisma (profile,
 * applications, integrations, platform credentials, resume versions, agent runs,
 * notifications, reports, audit logs), so deleting the user rows takes all of it.
 *
 * password_reset_tokens carries a user_id but declares no @relation, so Postgres
 * will NOT cascade it — those rows are deleted explicitly below, or they'd be
 * left orphaned pointing at users that no longer exist.
 *
 * NOT touched: the Job table (scraped listings are global, not user-owned) and
 * the OTP / rate-limit tables (keyed by phone/IP, self-expiring).
 *
 * ADMIN: this deletes your own account too, and with it your admin role — the
 * role column is only ever set by a script, so signing back in with Google makes
 * you an ordinary user. To get admin back:
 *     1. sign in at the site with Google (creates a fresh user + profile)
 *     2. node scripts/make-admin.mjs <your-email>
 *
 * Guard: refuses to run unless CONFIRM_PURGE_USERS=DELETE-ALL-USERS is set, so
 * it can never fire by accident from a stray `docker compose exec`.
 *
 * Run in prod:
 *   docker compose exec -e CONFIRM_PURGE_USERS=DELETE-ALL-USERS web \
 *     node scripts/purge-users.mjs
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CONFIRM = "DELETE-ALL-USERS";

async function main() {
  if (process.env.CONFIRM_PURGE_USERS !== CONFIRM) {
    console.error("REFUSING TO RUN — this deletes every user account and cannot be undone.");
    console.error(`Set CONFIRM_PURGE_USERS=${CONFIRM} to proceed.`);
    process.exit(1);
  }

  const before = await prisma.user.count();
  if (before === 0) {
    console.log("No users to delete. Nothing to do.");
    return;
  }

  const users = await prisma.user.findMany({ select: { email: true, role: true } });
  console.log(`About to delete ${before} user(s):`);
  for (const u of users) console.log(`  - ${u.email}${u.role === "admin" ? "  (admin)" : ""}`);

  // Orphans first: no FK relation means no cascade would ever clean these.
  const tokens = await prisma.passwordResetToken.deleteMany({});
  console.log(`password reset tokens removed: ${tokens.count}`);

  // Cascades through profiles, applications, integrations, credentials,
  // resume versions, agent runs, notifications, reports and audit logs.
  const deleted = await prisma.user.deleteMany({});
  console.log(`users removed: ${deleted.count}`);

  const after = await prisma.user.count();
  if (after !== 0) {
    console.error(`FAILED — ${after} user(s) still present.`);
    process.exit(1);
  }

  console.log("\nDone. 0 users remain.");
  console.log("Admin is gone too. Sign in with Google, then run:");
  console.log("  node scripts/make-admin.mjs <your-email>");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
