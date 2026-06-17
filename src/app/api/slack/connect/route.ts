import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { sendMessage } from "@/lib/adapters/slack";

/**
 * Stub Slack connect: user pastes their Slack member ID / channel + workspace.
 * Real version would run OAuth and store the bot token per-workspace.
 */
const schema = z.object({
  slackUserId: z.string().min(2).max(60),
  workspace: z.string().max(80).optional(),
});

export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const user = await prisma.user.update({
    where: { id: uid },
    data: {
      slackUserId: parsed.data.slackUserId,
      slackChannel: parsed.data.slackUserId, // DM channel == user id for the stub
      slackConnected: true,
    },
  });

  await sendMessage({
    channel: user.slackChannel || user.slackUserId!,
    text: `:link: Slack connected to InternPilot for *${user.name || user.email}*. Finish payment and I'll start applying.`,
  });

  return NextResponse.json({ ok: true });
}
