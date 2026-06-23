// One-off: wipe all credentials, create a single login account.
// Run: node scripts/seed-admin.mjs
import { PrismaClient } from "@prisma/client";
import { scrypt, randomBytes } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const prisma = new PrismaClient();

// matches src/lib/auth.ts hashPassword (salt:hash hex, scrypt 64)
async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${derived.toString("hex")}`;
}

const EMAIL = "admin@nexpath.test";
const PASSWORD = "NexPath@123";
const NAME = "Admin";

async function main() {
  // wipe everything credential-related (children cascade on user delete)
  await prisma.otpToken.deleteMany({});
  await prisma.application.deleteMany({});
  await prisma.report.deleteMany({});
  await prisma.userIntegration.deleteMany({});
  await prisma.profile.deleteMany({});
  await prisma.user.deleteMany({});

  const passwordHash = await hashPassword(PASSWORD);

  const user = await prisma.user.create({
    data: {
      email: EMAIL,
      name: NAME,
      passwordHash,
      // no phone => login skips OTP entirely (see src/app/api/login/route.ts)
      phone: null,
      phoneVerified: true,
      status: "active",
      role: "admin", // seeded account is the admin — unlocks /admin dashboard
      paid: true,
      plan: "pro",
      profile: { create: {} }, // all profile fields use schema defaults
    },
  });

  console.log("WIPED all users + otp tokens.");
  console.log("CREATED user:", user.id);
  console.log("  email   :", EMAIL);
  console.log("  password:", PASSWORD);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
