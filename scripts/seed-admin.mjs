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

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!user) {
    console.log(`[seed-admin] No account for ${email} yet. Sign up, then re-run.`);
    return;
  }
  if (user.role === "admin") {
    console.log(`[seed-admin] ${email} is already an admin.`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: "admin" } });
  console.log(`[seed-admin] ${email} promoted to admin.`);
}

main()
  .catch((e) => {
    console.error("[seed-admin]", e?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
