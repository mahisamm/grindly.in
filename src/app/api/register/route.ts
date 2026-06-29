import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/auth";
import { issueOtp, normalizePhone, maskPhone, isValidPhone, OtpRateLimitError } from "@/lib/otp";
import { DEFAULTS } from "@/lib/proffQuestions";
import { isRateLimited, getIp } from "@/lib/rateLimit";

// Strip all HTML tags and trim; used to sanitize free-text fields stored in DB.
function stripHtml(v: string): string {
  return v.replace(/<[^>]*>/g, "").trim();
}

const schema = z.object({
  email: z.string().email(),
  name: z.string().min(1, "Name is required").max(80).optional(),
  password: z.string().min(6, "Password must be at least 6 characters").max(200),
  phone: z.string().min(1, "Phone number required").max(16).refine((v) => v.replace(/\D/g, "").length >= 10, "Enter a valid 10-digit phone number"),
});

export async function POST(req: Request) {
  // 5 registrations per IP per hour — prevents SMS-pump abuse
  const ip = getIp(req);
  if (await isRateLimited(`register:${ip}`, 5, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Too many sign-up attempts. Try again in an hour." },
      { status: 429 }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 }
    );
  }
  const { email, password, phone: rawPhone } = parsed.data;
  const name = parsed.data.name ? stripHtml(parsed.data.name) : undefined;
  if (!isValidPhone(rawPhone)) {
    return NextResponse.json({ error: "Enter a valid phone number" }, { status: 400 });
  }
  const phone = normalizePhone(rawPhone);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists. Log in instead." },
      { status: 409 }
    );
  }

  const phoneExists = await prisma.user.findUnique({ where: { phone } });
  if (phoneExists) {
    return NextResponse.json(
      { error: "A phone number already registered. Log in instead." },
      { status: 409 }
    );
  }

  const passwordHash = await hashPassword(password);

  await prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      phone,
      phoneVerified: false,
      status: "onboarding",
      profile: {
        create: {
          skills: "[]",
          preferredDomains: JSON.stringify(DEFAULTS.preferredDomains),
          preferredLocations: JSON.stringify(DEFAULTS.preferredLocations),
          workMode: DEFAULTS.workMode as string,
          experienceLevel: DEFAULTS.experienceLevel as string,
          stipendMin: DEFAULTS.stipendMin as number,
          minMatchScore: DEFAULTS.minMatchScore as number,
          maxPerDay: DEFAULTS.maxPerDay as number,
          excludedCompanies: JSON.stringify(DEFAULTS.excludedCompanies),
          autoApply: DEFAULTS.autoApply as boolean,
        },
      },
    },
  });

  try {
    await issueOtp(phone);
  } catch (e) {
    if (e instanceof OtpRateLimitError) {
      return NextResponse.json({ error: e.message }, { status: 429 });
    }
    throw e;
  }
  return NextResponse.json({ ok: true, step: "otp", maskedPhone: maskPhone(phone) });
}
