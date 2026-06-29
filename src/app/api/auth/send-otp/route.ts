import { NextResponse } from "next/server";
import { z } from "zod";
import { issueOtp, normalizePhone, OtpRateLimitError } from "@/lib/otp";
import { isRateLimited, getIp } from "@/lib/rateLimit";

const schema = z.object({
  phone: z.string().min(10).max(16),
});

export async function POST(req: Request) {
  // Per-IP cap — this endpoint sends real SMS, so without it an attacker can
  // pump OTPs to arbitrary numbers (cost blow-up + harassment). otp.ts also caps
  // per-phone, but that doesn't stop spraying many different numbers.
  const ip = getIp(req);
  if (await isRateLimited(`sendotp:${ip}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many OTP requests. Try again later." },
      { status: 429 }
    );
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid phone" }, { status: 400 });

  const phone = normalizePhone(parsed.data.phone);
  try {
    await issueOtp(phone);
  } catch (e) {
    if (e instanceof OtpRateLimitError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true });
}
