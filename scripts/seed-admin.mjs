/**
 * Ensure ADMIN_EMAIL holds the admin role. Runs on every `docker compose up`
 * via the one-shot `migrate` service.
 *
 * PROMOTE ONLY — this must never CREATE the user. It used to upsert, and that
 * was a bug: any `docker compose up` after scripts/purge-users.mjs resurrected
 * the admin as a row with status "active" and NO Profile. The Google callback
 * links an *existing* email rather than creating (it only builds a profile in
 * the "no such user" branch), so that ghost row would never get a profile, and
 * an "active" status sends it straight to /dashboard instead of /onboarding.
 * Result: a permanently profile-less admin, and a purge that silently undid
 * itself on the next deploy.
 *
 * Bootstrapping a fresh database: sign in with Google (that creates the user
 * with a proper profile), then either run scripts/make-admin.mjs, or just
 * redeploy — this promotes on the next `up`.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const email = process.env.ADMIN_EMAIL || "mahendharsammeta21@gmail.com";

const user = await prisma.user.findUnique({ where: { email } });

if (!user) {
  console.log(`Admin seed: no account for ${email} — skipping. Sign in with Google, then run scripts/make-admin.mjs`);
} else if (user.role === "admin") {
  console.log(`Admin seed: ${email} already admin.`);
} else {
  await prisma.user.update({ where: { email }, data: { role: "admin" } });
  console.log(`Admin seed: ${email} role -> admin`);
}

await prisma.$disconnect();
