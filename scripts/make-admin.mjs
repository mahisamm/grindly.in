// Promote (or demote) a user to admin by email.
// Usage:
//   node scripts/make-admin.mjs user@example.com          # grant admin
//   node scripts/make-admin.mjs user@example.com --revoke # back to "user"
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  const revoke = process.argv.includes("--revoke");
  if (!email) {
    console.error("Usage: node scripts/make-admin.mjs <email> [--revoke]");
    process.exit(1);
  }
  const role = revoke ? "user" : "admin";
  const user = await prisma.user.update({
    where: { email },
    data: { role },
  }).catch(() => null);

  if (!user) {
    console.error(`No user with email ${email}`);
    process.exit(1);
  }
  console.log(`${email} role -> ${role}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
