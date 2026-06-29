/**
 * Email adapter — fallback channel when Slack is unconnected or failing.
 *
 * Production: set EMAIL_SMTP_HOST / _PORT / _USER / _PASS (+ EMAIL_FROM) and mail
 * goes out over SMTP via nodemailer.
 * Dev/prototype (no SMTP env): logs + appends to data/email-outbox.jsonl.
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

const OUTBOX = path.join(process.cwd(), "data", "email-outbox.jsonl");

export type Email = { to: string; subject: string; body: string };

function smtpConfigured(): boolean {
  return !!(process.env.EMAIL_SMTP_HOST && process.env.EMAIL_SMTP_USER);
}

let transporter: nodemailer.Transporter | null = null;
function getTransport(): nodemailer.Transporter {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SMTP_HOST,
      port: Number(process.env.EMAIL_SMTP_PORT || 587),
      secure: Number(process.env.EMAIL_SMTP_PORT || 587) === 465,
      auth: { user: process.env.EMAIL_SMTP_USER, pass: process.env.EMAIL_SMTP_PASS },
    });
  }
  return transporter;
}

export async function sendEmail(msg: Email): Promise<{ ok: boolean; stub: boolean }> {
  if (smtpConfigured()) {
    try {
      await getTransport().sendMail({
        from: process.env.EMAIL_FROM || "Grindly <no-reply@grindly.app>",
        to: msg.to,
        subject: msg.subject,
        text: msg.body,
      });
      return { ok: true, stub: false };
    } catch (e) {
      console.error("[email] SMTP send failed, falling back to outbox:", (e as Error).message);
      // fall through to outbox so the message is at least persisted
    }
  }

  const dir = path.dirname(OUTBOX);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(OUTBOX, JSON.stringify({ ts: new Date().toISOString(), ...msg }) + "\n", "utf8");
  console.log(`[email:stub] → ${msg.to}: ${msg.subject}`);
  return { ok: true, stub: true };
}
