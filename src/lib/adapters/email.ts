/**
 * The one way mail leaves this application: password resets and email
 * verification.
 *
 * Production: set EMAIL_SMTP_HOST / _PORT / _USER / _PASS (+ EMAIL_FROM) and mail
 * goes out over SMTP via nodemailer.
 * Dev/prototype (no SMTP env): logs + appends to data/email-outbox.jsonl, so the
 * whole reset and verification flow is exercisable locally with no mail server
 * and no account anywhere — read the token out of the outbox file.
 */
import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import { report } from "@/lib/errors";

const OUTBOX = path.join(process.cwd(), "data", "email-outbox.jsonl");

export type Email = { to: string; subject: string; body: string };

// Must agree with config.smtpConfigured(). These disagreed — HOST+USER here,
// HOST+USER+PASS there — so a deployment with a host and user but no password
// was "configured" to this file and "not configured" to everything else.
function smtpConfigured(): boolean {
  return !!(
    process.env.EMAIL_SMTP_HOST &&
    process.env.EMAIL_SMTP_USER &&
    process.env.EMAIL_SMTP_PASS
  );
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
      // SMTP is configured, so this was a real attempt at a real mailbox and it
      // failed. Record it where the operator will see it. A console line alone
      // put a production outage in a container log nobody tails, while the
      // caller was handed `stub: true` — the same answer a dev box with no mail
      // server gives — so nothing downstream could tell the two apart.
      // report() never throws and is not awaited; the outbox write still
      // happens below so the message is at least persisted.
      report({
        source: "web",
        kind: "smtp-send-failed",
        message: String((e as Error)?.message ?? e).slice(0, 400),
        context: msg.subject,
      });
    }
  }

  const dir = path.dirname(OUTBOX);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(OUTBOX, JSON.stringify({ ts: new Date().toISOString(), ...msg }) + "\n", "utf8");
  console.log(`[email:stub] → ${msg.to}: ${msg.subject}`);
  return { ok: true, stub: true };
}
