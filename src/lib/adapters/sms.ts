// SMS adapter — multi-provider so India beta works without Twilio.
//   * Fast2SMS  (India, OTP route, no DLT template needed) — easiest to start.
//   * MSG91     (India, flow API, needs a DLT-approved template_id) — scales.
//   * Twilio    (international) — generic text.
// Provider is chosen from whichever keys are set (see serverConfig.smsProvider).
// We generate + rate-limit + brute-force-guard the OTP ourselves (src/lib/otp.ts);
// providers only deliver the message.
import twilio from "twilio";
import { smsProvider } from "@/lib/serverConfig";

const SEND_TIMEOUT_MS = 10_000;

function otpText(code: string): string {
  return `Your Grindly OTP is: ${code}. Valid for 10 minutes. Do not share with anyone.`;
}

function digitsOf(phone: string): string {
  return phone.replace(/\D/g, "");
}

async function postForm(url: string, body: URLSearchParams, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url: string, json: unknown, headers: Record<string, string>): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    return await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(json), signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ── Fast2SMS — OTP route delivers "Your OTP is <code>" to a bare 10-digit number.
async function sendViaFast2Sms(phone: string, code: string): Promise<void> {
  const numbers = digitsOf(phone).slice(-10);
  const res = await postForm(
    "https://www.fast2sms.com/dev/bulkV2",
    new URLSearchParams({ route: "otp", variables_values: code, numbers }),
    { authorization: process.env.FAST2SMS_API_KEY!, "Content-Type": "application/x-www-form-urlencoded" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Fast2SMS send failed (${res.status}): ${detail.slice(0, 200)}`);
  }
}

// ── MSG91 — flow API; template has an OTP variable (default key "OTP", override
//    with MSG91_OTP_VAR to match your DLT template). mobiles = country code + number.
async function sendViaMsg91(phone: string, code: string): Promise<void> {
  const d = digitsOf(phone);
  const mobiles = d.startsWith("91") ? d : `91${d.slice(-10)}`;
  const otpVar = process.env.MSG91_OTP_VAR || "OTP";
  const res = await postJson(
    "https://control.msg91.com/api/v5/flow/",
    {
      template_id: process.env.MSG91_TEMPLATE_ID,
      sender: process.env.MSG91_SENDER_ID,
      short_url: "0",
      recipients: [{ mobiles, [otpVar]: code }],
    },
    { authkey: process.env.MSG91_AUTH_KEY!, accept: "application/json" }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`MSG91 send failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  // MSG91 returns 200 with {type:"error"} on some failures — surface those too.
  const data = await res.json().catch(() => null) as { type?: string; message?: string } | null;
  if (data && data.type === "error") {
    throw new Error(`MSG91 send error: ${String(data.message).slice(0, 200)}`);
  }
}

async function sendViaTwilio(to: string, body: string): Promise<void> {
  const client = twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);
  await client.messages.create({ to, from: process.env.TWILIO_FROM_NUMBER!, body });
}

/** Deliver an OTP via the configured provider. Throws on send failure so the
 *  caller never tells the user "code sent" when it wasn't. */
export async function sendOtp(phone: string, code: string): Promise<void> {
  switch (smsProvider()) {
    case "fast2sms":
      return sendViaFast2Sms(phone, code);
    case "msg91":
      return sendViaMsg91(phone, code);
    case "twilio":
      return sendViaTwilio(phone, otpText(code));
    default:
      // No provider. In dev we print the OTP so local signup works; in prod this
      // is a hard failure — silently dropping it would let anyone "verify" a code
      // that was never sent.
      if (process.env.NODE_ENV === "production") {
        throw new Error("SMS provider not configured (set FAST2SMS_API_KEY, MSG91_*, or TWILIO_*)");
      }
      console.log(`[SMS DEV] To: ${phone} | ${otpText(code)}`);
  }
}

/** Generic transactional SMS (non-OTP). Currently only Twilio carries free-text;
 *  Fast2SMS/MSG91 here are OTP-template bound. Kept for future notifications. */
export async function sendSms(to: string, body: string): Promise<void> {
  if (smsProvider() === "twilio") return sendViaTwilio(to, body);
  if (process.env.NODE_ENV === "production") {
    throw new Error("Generic SMS requires Twilio (TWILIO_*)");
  }
  console.log(`[SMS DEV] To: ${to} | ${body}`);
}
