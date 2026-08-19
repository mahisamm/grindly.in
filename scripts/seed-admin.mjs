#!/usr/bin/env node
/**
 * Promote ADMIN_EMAIL to the admin role, creating nothing.
 *
 * Deliberately does NOT create an account with a password. A seeded credential
 * is a credential somebody forgets to change, and this runs in the Docker
 * `migrate` step where its output goes to a log. So: sign up normally, then run
 * this. If the address has not signed up yet, the signup route promotes the
 * first account and any address matching ADMIN_EMAIL anyway — this script is the
 * fix-it-afterwards path, not the primary one.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) {
    console.log("[seed-admin] ADMIN_EMAIL is not set — nothing to do.");
    return;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true, accessStatus: true },
  });
  if (!user) {
    console.log(`[seed-admin] No account for ${email} yet. Sign up, then re-run.`);
    return;
  }
  // Approved as well as promoted. `isApproved` already lets admins through the
  // beta gate whatever the column says, so this is belt and braces — but the
  // column is what the admin page DISPLAYS, and an operator reading "pending"
  // next to their own name would reasonably conclude the gate was broken.
  if (user.role === "admin" && user.accessStatus === "approved") {
    console.log(`[seed-admin] ${email} is already an admin.`);
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      role: "admin",
      accessStatus: "approved",
      approvedAt: new Date(),
      approvedBy: "seed-admin",
    },
  });
  console.log(`[seed-admin] ${email} promoted to admin.`);
}

main()
  .catch((e) => {
    console.error("[seed-admin]", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
