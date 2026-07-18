/**
 * Slack adapter — stubbed, real-ready.
 *
 * Local/dev: messages are logged + appended to a JSONL outbox file so the
 * onboarding bot conversation is fully simulated without a real workspace.
 *
 * Production: set SLACK_BOT_TOKEN. `sendMessage` will POST to chat.postMessage.
 * Nothing else in the app changes — same function signature.
 */
import fs from "node:fs";
import path from "node:path";

const OUTBOX = path.join(process.cwd(), "data", "slack-outbox.jsonl");

export type SlackMessage = {
  channel: string; // channel id or user id (DM)
  text: string;
  blocks?: unknown[];
};

function ensureOutbox() {
  const dir = path.dirname(OUTBOX);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function sendMessage(msg: SlackMessage): Promise<{ ok: boolean; stub: boolean }> {
  const token = process.env.SLACK_BOT_TOKEN;

  if (token) {
    // ---- real Slack path ----
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(msg),
    });
    const data = (await res.json()) as { ok: boolean };
    return { ok: data.ok, stub: false };
  }

  // ---- stub path: persist to outbox so the UI/agent can replay it ----
  ensureOutbox();
  fs.appendFileSync(
    OUTBOX,
    JSON.stringify({ ts: new Date().toISOString(), ...msg }) + "\n",
    "utf8"
  );
  console.log(`[slack:stub] → ${msg.channel}: ${msg.text.slice(0, 120)}`);
  return { ok: true, stub: true };
}

/** The onboarding questions the bot DMs the user right after payment. */
export function onboardingDM(name: string): string {
  return [
    `:wave: Hey ${name || "there"} — I'm *Grindly*, your application assistant.`,
    ``,
    `Payment confirmed :white_check_mark:. I'll start applying to internships that match your resume.`,
    `Before I do, reply here (or finish setup on the dashboard) so I apply *smart*:`,
    `  1. Target domains? (e.g. web dev, data science, marketing)`,
    `  2. Locations / remote-only?`,
    `  3. Minimum stipend?`,
    `  4. Any companies to avoid?`,
    ``,
    `I'll send you a progress report here every day at 9am. Let's go :rocket:`,
  ].join("\n");
}
