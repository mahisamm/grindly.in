import { randomInt } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { prisma } from "@/lib/prisma";
import { sendOtp } from "@/lib/adapters/sms";
import { audit } from "@/lib/audit";

// ── anti-abuse limits (SMS-pump / bill-blowup defense) ──
const COOLDOWN_MS = 60_000; // min gap between OTP sends to one phone
const MAX_PER_DAY = 5;      // max OTP issues per phone per day

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
export function normalizePhone(raw: string): string {
  const parsed = parsePhoneNumberFromString(raw, "IN");
  if (parsed && parsed.isValid()) return parsed.number;

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

  // Reset brute-force counter in DB — new OTP starts fresh
  await prisma.otpAttempt.deleteMany({ where: { phone } });

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

// ── OTP brute-force protection ────────────────────────────────────────────
// Max 5 wrong guesses per phone before a 15-min lockout. DB-backed so it
// survives multi-instance / serverless restarts.

const OTP_MAX_ATTEMPTS = 5;
const OTP_LOCKOUT_MS = 15 * 60 * 1000; // 15 min

export class OtpLockedError extends Error {
  retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super("Too many wrong attempts. Please request a new OTP.");
    this.name = "OtpLockedError";
    this.retryAfterSec = retryAfterSec;
  }
}

export async function verifyOtp(phone: string, code: string): Promise<boolean> {
  const now = new Date();

  // Check lockout from DB
  const attemptRow = await prisma.otpAttempt.findUnique({ where: { phone } });
  if (attemptRow?.lockedUntil && attemptRow.lockedUntil > now) {
    const retryAfterSec = Math.ceil((attemptRow.lockedUntil.getTime() - now.getTime()) / 1000);
    throw new OtpLockedError(retryAfterSec);
  }

  const token = await prisma.otpToken.findFirst({
    where: { phone, code, used: false, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });

  if (!token) {
    await audit("otp_verify_fail", { target: maskPhone(phone) });

    // Age out a stale counter: once the previous window has passed, the next
    // wrong guess must start from 0 — otherwise attempts stay pinned at the cap
    // and the first guess after a lockout expires re-locks instantly.
    const windowExpired = attemptRow?.windowEnd ? attemptRow.windowEnd <= now : false;
    const currentAttempts = windowExpired ? 0 : (attemptRow?.attempts ?? 0);
    const newAttempts = currentAttempts + 1;
    const windowEnd = new Date(now.getTime() + OTP_LOCKOUT_MS);

    if (newAttempts >= OTP_MAX_ATTEMPTS) {
      await prisma.otpAttempt.upsert({
        where: { phone },
        update: { attempts: newAttempts, lockedUntil: windowEnd, windowEnd },
        create: { phone, attempts: newAttempts, lockedUntil: windowEnd, windowEnd },
      });
      await audit("otp_locked", { target: maskPhone(phone) });
      throw new OtpLockedError(Math.ceil(OTP_LOCKOUT_MS / 1000));
    }

    await prisma.otpAttempt.upsert({
      where: { phone },
      update: { attempts: newAttempts, windowEnd },
      create: { phone, attempts: newAttempts, windowEnd },
    });
    return false;
  }

  // Success — clear attempt counter and consume token
  await prisma.otpAttempt.deleteMany({ where: { phone } });
  await prisma.otpToken.update({ where: { id: token.id }, data: { used: true } });
  return true;
}
