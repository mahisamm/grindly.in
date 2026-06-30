import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";

const PLATFORM = "internshala";

const Body = z.object({
  code: z.string().trim().min(3, "Enter the code Internshala sent you.").max(12),
});

/**
 * POST /api/integrations/internshala/otp  body: { code }
 *
 * OTP relay: while the worker is mid-login and blocked on a one-time code, it
 * polls user_integrations.otp_code. The user reads the code from their email/SMS
 * and posts it here; the worker picks it up, submits it, and finishes login.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid code." },
      { status: 400 },
    );
  }

  const row = await prisma.userIntegration.findUnique({
    where: { userId_platform: { userId: uid, platform: PLATFORM } },
  });
  if (!row || !row.otpRequired) {
    return NextResponse.json({ error: "No one-time code is being requested right now." }, { status: 409 });
  }

  await prisma.userIntegration.update({
    where: { userId_platform: { userId: uid, platform: PLATFORM } },
    data: { otpCode: parsed.data.code },
  });

  return NextResponse.json({ ok: true });
}
