import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.profile.updateMany({
    where: {
      autoApplyConsentAt: null,
      user: {
        status: "active",
      },
    },
    data: {
      autoApplyConsentAt: new Date(),
    },
  });

  console.log(`Backfill complete: ${result.count} profile(s) updated with autoApplyConsentAt = NOW().`);
}

main()
  .catch((e) => {
    console.error("Backfill failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
