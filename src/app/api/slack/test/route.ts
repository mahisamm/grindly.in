import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { sendMessage } from "@/lib/adapters/slack";

/**
 * POST /api/slack/test — fire a test message to the user's saved Slack channel
 * so they can confirm delivery. Reports stub vs real so the dashboard can tell
 * the user to set SLACK_BOT_TOKEN if it only hit the local outbox.
 */
export async function POST() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  const channel = user.slackChannel || user.slackUserId;
  if (!channel) {
    return NextResponse.json({ error: "Connect Slack first (enter your member ID)." }, { status: 400 });
  }

  const { ok, stub } = await sendMessage({
    channel,
    text: `:satellite: Test from Grindly — Slack is wired up for *${user.name || user.email}*. Daily reports will land here.`,
  });

  if (!ok) {
    return NextResponse.json(
      { error: "Slack rejected the message. Check the bot token and that the bot can DM you." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, stub });
}
