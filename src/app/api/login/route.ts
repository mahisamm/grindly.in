import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth";
import { issueOtp, maskPhone, OtpRateLimitError } from "@/lib/otp";
import { audit } from "@/lib/audit";
import { isRateLimited, getIp } from "@/lib/rateLimit";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  // 10 attempts per IP per 15 minutes
  const ip = getIp(req);
  if (await isRateLimited(`login:${ip}`, 10, 15 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many login attempts. Try again in 15 minutes." },
      { status: 429 }
    );
  }

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

  // Accounts without a verified phone cannot log in — they must complete
  // registration (add + verify phone) before accessing the app.
  if (!user.phone || !user.phoneVerified) {
    await audit("login_fail", { target: email, detail: "phone not verified" });
    return NextResponse.json(
      { error: "Phone verification required. Please complete your registration." },
      { status: 403 }
    );
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
