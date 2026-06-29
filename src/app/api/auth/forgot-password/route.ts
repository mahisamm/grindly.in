import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/adapters/email";
import { createResetToken } from "@/lib/passwordReset";
import { isRateLimited, getIp } from "@/lib/rateLimit";
import { baseUrl } from "@/lib/baseUrl";

const schema = z.object({ email: z.string().email() });

export async function POST(req: Request) {
  const ip = getIp(req);
  if (await isRateLimited(`forgot:${ip}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json({ ok: true }); // silent — don't reveal rate limit
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid email" }, { status: 400 });

  const { email } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  if (user) {
    const token = await createResetToken(user.id);
    const base = baseUrl();
    const link = `${base}/reset-password?token=${token}`;

    await sendEmail({
      to: email,
      subject: "Reset your Grindly password",
      body: `Hi${user.name ? ` ${user.name}` : ""},\n\nClick the link below to reset your password. It expires in 15 minutes.\n\n${link}\n\nIf you didn't request this, ignore this email — your password won't change.`,
    });
  }

  // Always return ok to prevent email enumeration
  return NextResponse.json({ ok: true });
}
