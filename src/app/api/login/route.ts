import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { setUid } from "@/lib/session";
import { verifyPassword } from "@/lib/auth";
import { issueOtp, maskPhone, OtpRateLimitError } from "@/lib/otp";
import { audit } from "@/lib/audit";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    await audit("login_fail", { target: email });
    return NextResponse.json({ error: "Wrong email or password" }, { status: 401 });
  }

  // Accounts without a phone: grant session directly (no OTP).
  // NOTE: prototype convenience only — in production every account should have a
  // verified phone and go through OTP. See report (dev-bypass hardening).
  if (!user.phone) {
    await setUid(user.id);
    await audit("login", { userId: user.id, detail: "no-phone direct session" });
    return NextResponse.json({ ok: true, userId: user.id, status: user.status });
  }

  try {
    await issueOtp(user.phone);
  } catch (e) {
    if (e instanceof OtpRateLimitError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true, step: "otp", maskedPhone: maskPhone(user.phone) });
}
