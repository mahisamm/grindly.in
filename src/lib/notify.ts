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

/**
 * Convenience wrapper: look up the user's own channels (slack + email) and
 * notify them. Best-effort by design — a notification must never block or fail
 * the action that triggered it, so every call site should `void notifyUser(...)`
 * (or await inside a try). Returns { delivered } for callers that care.
 */
export async function notifyUser(
  userId: string,
  input: { tier: Tier; title: string; body: string }
): Promise<{ delivered: boolean }> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, slackChannel: true, slackConnected: true },
    });
    if (!u) return { delivered: false };
    return notify({
      userId,
      tier: input.tier,
      title: input.title,
      body: input.body,
      slackChannel: u.slackConnected ? u.slackChannel : null,
      email: u.email,
    });
  } catch (e) {
    console.error("[notify] notifyUser failed:", (e as Error).message);
    return { delivered: false };
  }
}

export async function notify(input: NotifyInput): Promise<{ delivered: boolean }> {
  const { userId, tier, title, body, slackChannel, email } = input;
  const text = `*${title}*\n${body}`;
  let slackOk = false;
  let emailOk = false;

  // Always land an in-app notification first. It needs no external service, so
  // the dashboard bell is the one channel that works for 100 users on day one —
  // Slack/email are proactive add-ons layered on top when configured.
  await record(userId, tier, "inapp", title, body, true);

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
      const r = await sendEmail({ to: email!, subject: `Grindly: ${title}`, body });
      emailOk = r.ok;
    } catch (e) {
      console.error("[notify] email failed:", (e as Error).message);
    }
    await record(userId, tier, "email", title, body, emailOk);
  }

  return { delivered: slackOk || emailOk };
}
