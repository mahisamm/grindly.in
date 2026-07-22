import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { audit } from "@/lib/audit";
import { isRateLimited } from "@/lib/rateLimit";
import { supportAssist, SUPPORT_FALLBACK_REPLY, type SupportMsg } from "@/lib/supportAI";
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

  const replyText = ai?.reply ?? SUPPORT_FALLBACK_REPLY;
  history.push({ role: "assistant", content: replyText, at: new Date().toISOString() });

  // Triage: prefer the fresh AI read, else keep the ticket's prior values, else
  // fall back to the raw first line so the admin queue is never blank.
  const data = {
    messagesJson: JSON.stringify(history.slice(-MAX_STORED)),
    subject: ai?.subject ?? existing?.subject ?? message.slice(0, 70),
    category: ai?.category ?? existing?.category ?? "other",
    severity: ai?.severity ?? existing?.severity ?? "normal",
    summary: ai?.summary ?? existing?.summary ?? message.slice(0, 200),
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

  return NextResponse.json({ ticketId, reply: replyText, aiHandled: !!ai });
}
