// Tiered notifications with channel fallback + delivery tracking.
//
//  tier "urgent"  → action-needed (session dead, recruiter reply, interview).
//                   Tries Slack AND email so the user can't miss it.
//  tier "digest"  → daily summary. Slack only; email fallback if no Slack.
//
// Every send is recorded in the Notification table with `delivered`, so a user
// is never silently left blind (the over/under-notification problem).
import { prisma } from "./prisma";
import { sendMessage } from "./adapters/slack";
import { sendEmail } from "./adapters/email";

export type Tier = "urgent" | "digest";

export type NotifyInput = {
  userId: string;
  tier: Tier;
  title: string;
  body: string;
  slackChannel?: string | null;
  email?: string | null;
};

async function record(userId: string, tier: Tier, channel: string, title: string, body: string, delivered: boolean) {
  try {
    await prisma.notification.create({ data: { userId, tier, channel, title, body, delivered } });
  } catch (e) {
    console.error("[notify] record failed:", (e as Error).message);
  }
}

export async function notify(input: NotifyInput): Promise<{ delivered: boolean }> {
  const { userId, tier, title, body, slackChannel, email } = input;
  const text = `*${title}*\n${body}`;
  let slackOk = false;
  let emailOk = false;

  if (slackChannel) {
    try {
      const r = await sendMessage({ channel: slackChannel, text });
      slackOk = r.ok;
    } catch (e) {
      console.error("[notify] slack failed:", (e as Error).message);
    }
    await record(userId, tier, "slack", title, body, slackOk);
  }

  // Email on urgent always, or as fallback when Slack didn't land.
  const wantEmail = email && (tier === "urgent" || !slackOk);
  if (wantEmail) {
    try {
      const r = await sendEmail({ to: email!, subject: `NexPath: ${title}`, body });
      emailOk = r.ok;
    } catch (e) {
      console.error("[notify] email failed:", (e as Error).message);
    }
    await record(userId, tier, "email", title, body, emailOk);
  }

  return { delivered: slackOk || emailOk };
}
