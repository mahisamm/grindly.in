import { randomInt } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { prisma } from "@/lib/prisma";
import { sendOtp } from "@/lib/adapters/sms";
import { audit } from "@/lib/audit";

// ── anti-abuse limits (SMS-pump / bill-blowup defense) ──
const COOLDOWN_MS = 60_000; // min gap between OTP sends to one phone
const MAX_PER_DAY = 5; // max OTP issues per phone per day

export class OtpRateLimitError extends Error {
  retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = "OtpRateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return `****${digits.slice(-4)}`;
}

// Proper E.164 normalization via libphonenumber (default region India).
// Falls back to the old heuristic if the lib can't parse.
export function normalizePhone(raw: string): string {
  const parsed = parsePhoneNumberFromString(raw, "IN");
  if (parsed && parsed.isValid()) return parsed.number; // E.164, e.g. +919876543210

  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return `+${digits}`;
}

export function isValidPhone(raw: string): boolean {
  const parsed = parsePhoneNumberFromString(raw, "IN");
  return !!parsed && parsed.isValid();
}

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function issueOtp(phone: string): Promise<void> {
  // throttle: cooldown since last send
  const last = await prisma.otpToken.findFirst({
    where: { phone },
    orderBy: { createdAt: "desc" },
  });
  if (last) {
    const sinceMs = Date.now() - last.createdAt.getTime();
    if (sinceMs < COOLDOWN_MS) {
      const retry = Math.ceil((COOLDOWN_MS - sinceMs) / 1000);
      await audit("otp_throttled", { target: maskPhone(phone), detail: "cooldown" });
      throw new OtpRateLimitError("Please wait before requesting another OTP.", retry);
    }
  }

  // throttle: daily cap
  const todayCount = await prisma.otpToken.count({
    where: { phone, createdAt: { gte: new Date(startOfTodayMs()) } },
  });
  if (todayCount >= MAX_PER_DAY) {
    await audit("otp_throttled", { target: maskPhone(phone), detail: "daily_cap" });
    throw new OtpRateLimitError("Too many OTP requests today. Try again tomorrow.", 3600);
  }

  const code = randomInt(100000, 999999).toString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await prisma.otpToken.updateMany({
    where: { phone, used: false },
    data: { used: true },
  });
  await prisma.otpToken.create({ data: { phone, code, expiresAt } });
  await sendOtp(phone, code);
  await audit("otp_issued", { target: maskPhone(phone) });
}

export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  const token = await prisma.otpToken.findFirst({
    where: { phone, code, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!token) {
    await audit("otp_verify_fail", { target: maskPhone(phone) });
    return false;
  }
  await prisma.otpToken.update({ where: { id: token.id }, data: { used: true } });
  return true;
}
