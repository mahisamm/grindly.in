import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const u = await prisma.user.upsert({
  where: { email: "mahendharsammeta21@gmail.com" },
  create: {
    email: "mahendharsammeta21@gmail.com",
    name: "Mahendhar",
    role: "admin",
    status: "active",
    paid: true,
    plan: "pro",
  },
  update: { role: "admin" },
});
console.log("Admin seeded:", u.email, u.role);
await prisma.$disconnect();
