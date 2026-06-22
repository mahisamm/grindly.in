import twilio from "twilio";

const SID = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM = process.env.TWILIO_FROM_NUMBER;

export async function sendSms(to: string, body: string): Promise<void> {
  if (!SID || !TOKEN || !FROM) {
    // No Twilio creds. In dev we print the OTP so local signup works.
    // In production this is a hard failure — silently dropping the OTP would
    // let anyone "verify" with a code that was never sent.
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMS provider not configured (TWILIO_* env missing)");
    }
    console.log(`[SMS DEV] To: ${to} | ${body}`);
    return;
  }
  const client = twilio(SID, TOKEN);
  await client.messages.create({ to, from: FROM, body });
}

export async function sendOtp(phone: string, code: string): Promise<void> {
  await sendSms(
    phone,
    `Your NexPath OTP is: ${code}. Valid for 10 minutes. Do not share with anyone.`
  );
}
