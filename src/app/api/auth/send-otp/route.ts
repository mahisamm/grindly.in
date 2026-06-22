import { NextResponse } from "next/server";
import { z } from "zod";
import { issueOtp, normalizePhone, OtpRateLimitError } from "@/lib/otp";

const schema = z.object({
  phone: z.string().min(10).max(16),
});

export async function POST(req: Request) {
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
