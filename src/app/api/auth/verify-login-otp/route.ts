import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { verifyOtp } from "@/lib/otp";

const schema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { email, code } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.phone) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const valid = await verifyOtp(user.phone, code);
  if (!valid) return NextResponse.json({ error: "Invalid or expired OTP" }, { status: 401 });

  if (!user.phoneVerified) {
    await prisma.user.update({ where: { id: user.id }, data: { phoneVerified: true } });
  }

  await setUid(user.id);
  return NextResponse.json({ ok: true, userId: user.id, status: user.status });
}
