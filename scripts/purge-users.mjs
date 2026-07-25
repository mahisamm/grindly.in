/**
 * Wipe every non-admin user account and all data owned by them. Irreversible.
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
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "mahendharsammeta21@gmail.com").trim().toLowerCase();

async function main() {
  if (process.env.CONFIRM_PURGE_USERS !== CONFIRM) {
    console.error("REFUSING TO RUN — this deletes every user account and cannot be undone.");
    console.error(`Set CONFIRM_PURGE_USERS=${CONFIRM} to proceed.`);
    process.exit(1);
  }

  const admin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (!admin) {
    console.error(`REFUSING TO RUN - admin account ${ADMIN_EMAIL} does not exist.`);
    console.error("Sign in with that account first, then run this purge again.");
    process.exit(1);
  }

  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  const removable = users.filter((u) => u.id !== admin.id);
  if (removable.length === 0) {
    if (admin.role !== "admin") {
      await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });
    }
    console.log(`No non-admin users to delete. Preserved ${ADMIN_EMAIL} as admin.`);
    return;
  }

  console.log(`About to delete ${removable.length} non-admin user(s), preserving ${ADMIN_EMAIL}:`);
  for (const u of removable) console.log(`  - ${u.email}${u.role === "admin" ? "  (admin role removed)" : ""}`);

  await prisma.user.update({ where: { id: admin.id }, data: { role: "admin" } });

  // Orphans first: no FK relation means no cascade would ever clean these.
  const tokens = await prisma.passwordResetToken.deleteMany({
    where: { userId: { not: admin.id } },
  });
  console.log(`password reset tokens removed: ${tokens.count}`);

  // Cascades through profiles, applications, integrations, credentials,
  // resume versions, agent runs, notifications, reports and audit logs.
  const deleted = await prisma.user.deleteMany({ where: { id: { not: admin.id } } });
  console.log(`non-admin users removed: ${deleted.count}`);

  const remaining = await prisma.user.findMany({ select: { id: true, email: true, role: true } });
  const after = remaining.length;
  if (remaining.length !== 1 || remaining[0]?.id !== admin.id || remaining[0]?.role !== "admin") {
    console.error(`FAILED — ${after} user(s) still present.`);
    process.exit(1);
  }

  console.log(`\nDone. 1 user remains: ${ADMIN_EMAIL} (admin).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
