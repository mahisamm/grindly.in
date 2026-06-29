import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { verifyOtp, normalizePhone, OtpLockedError } from "@/lib/otp";

const schema = z.object({
  phone: z.string().min(10).max(16),
  code: z.string().length(6),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const phone = normalizePhone(parsed.data.phone);
  const { code } = parsed.data;

  let valid: boolean;
  try {
    valid = await verifyOtp(phone, code);
  } catch (e) {
    if (e instanceof OtpLockedError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    throw e;
  }
  if (!valid) return NextResponse.json({ error: "Invalid or expired OTP" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

  if (!user.phoneVerified) {
    await prisma.user.update({ where: { id: user.id }, data: { phoneVerified: true } });
  }

  await setUid(user.id);
  return NextResponse.json({ ok: true, userId: user.id, status: user.status });
}
