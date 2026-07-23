import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";
import { isRateLimited } from "@/lib/rateLimit";
import {
  supportAssist,
  isRepeatReply,
  SUPPORT_FALLBACK_REPLY,
  SUPPORT_OFFTOPIC_REPLY,
  SUPPORT_ESCALATION_REPLY,
  type SupportMsg,
} from "@/lib/supportAI";
import { normalizePlan } from "@/lib/plans";

export const dynamic = "force-dynamic";

const MAX_LEN = 4000;   // per-message cap
const MAX_STORED = 60;  // keep a ticket bounded — trim oldest turns beyond this

function parseMessages(json: string): SupportMsg[] {
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
    );
  } catch {
    return [];
  }
}

/**
 * One turn of the in-app support chat. Appends the user's message to their
 * single OPEN ticket (server-owned identity — a user can only touch their own),
 * asks the assistant for a reply + triage, appends the reply, and persists.
 *
 * The ticket is saved even when the model is unavailable (canned reply, raw
 * text preserved) so nothing a user reports is ever dropped.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  if (!message) return NextResponse.json({ error: "empty message" }, { status: 400 });
  if (message.length > MAX_LEN) return NextResponse.json({ error: "message too long" }, { status: 400 });

  // Per-user guard on the AI call (cost + abuse). 20 messages / 5 min.
  if (await isRateLimited(`support:${uid}`, 20, 5 * 60 * 1000)) {
    return NextResponse.json({ error: "Too many messages — please wait a minute." }, { status: 429 });
  }

  const user = await prisma.user.findUnique({
    where: { id: uid },
    select: { name: true, plan: true, status: true },
  });
  if (!user) return NextResponse.json({ error: "no session" }, { status: 401 });

  const existing = await prisma.supportTicket.findFirst({
    where: { userId: uid, status: "open" },
    orderBy: { updatedAt: "desc" },
  });

  const history: SupportMsg[] = existing ? parseMessages(existing.messagesJson) : [];
  history.push({ role: "user", content: message, at: new Date().toISOString() });

  const userContext = `name=${user.name ?? "unknown"}, plan=${normalizePlan(user.plan)}, accountStatus=${user.status}`;
  const ai = await supportAssist(userContext, history);

  // Scope firewall: an out-of-scope request (general coding, trivia, travel,
  // homework, …) gets a fixed redirect and is NOT filed as a ticket — no admin
  // noise, nothing stored. The model flags it; the server owns the response text
  // so a jailbroken prompt can't coax a real answer through us.
  if (ai?.offTopic) {
    return NextResponse.json({
      ticketId: existing?.id ?? null,
      reply: SUPPORT_OFFTOPIC_REPLY,
      offTopic: true,
      aiHandled: true,
    });
  }

  // Loop breaker. The prompt tells the model not to repeat itself, but a prompt
  // is not a guarantee — so the server checks. If this reply says the same thing
  // as the last one, the user is stuck in a paraphrase loop: replace it with a
  // hand-off and escalate the ticket instead of letting the bot stonewall.
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  const looped = !!ai && !!lastAssistant && isRepeatReply(ai.reply, lastAssistant.content);

  const replyText = looped ? SUPPORT_ESCALATION_REPLY : (ai?.reply ?? SUPPORT_FALLBACK_REPLY);
  history.push({ role: "assistant", content: replyText, at: new Date().toISOString() });

  // Triage: prefer the fresh AI read, else keep the ticket's prior values, else
  // fall back to the raw first line so the admin queue is never blank. A looped
  // answer is by definition unresolved by the bot — force it to the top of the
  // queue regardless of what the model thought the severity was.
  const data = {
    messagesJson: JSON.stringify(history.slice(-MAX_STORED)),
    subject: ai?.subject ?? existing?.subject ?? message.slice(0, 70),
    category: ai?.category ?? existing?.category ?? "other",
    severity: looped ? "high" : (ai?.severity ?? existing?.severity ?? "normal"),
    summary: looped
      ? `NEEDS A HUMAN — the assistant repeated itself and could not answer. ${ai?.summary ?? message.slice(0, 200)}`.slice(0, 400)
      : (ai?.summary ?? existing?.summary ?? message.slice(0, 200)),
  };

  let ticketId: string;
  if (existing) {
    await prisma.supportTicket.update({ where: { id: existing.id }, data });
    ticketId = existing.id;
  } else {
    const created = await prisma.supportTicket.create({ data: { userId: uid, ...data } });
    ticketId = created.id;
    await audit("support_ticket_opened", { userId: uid, target: data.category, detail: data.subject });
  }

  return NextResponse.json({ ticketId, reply: replyText, aiHandled: !!ai, escalated: looped });
}
