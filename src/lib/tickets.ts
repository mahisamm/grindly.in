/**
 * Support conversations: one user, Grindly's assistant, and — when it comes to
 * that — a person on the team.
 *
 * Every conversation starts with the ASSISTANT (agent/support_chat.py). It
 * answers from the product notes in lib/support.ts, keeps a running summary
 * for the operator, and hands over (`handledBy: human`) when money, data,
 * an unresolved bug, or a plain "I want a person" comes up. From the moment
 * it hands over — or an operator replies — the assistant stays silent and
 * the thread is a human conversation.
 *
 * Access is by OWNERSHIP or ROLE, checked here once. The "seen" stamps are
 * written when a side READS the thread; that drives both unread badges.
 *
 * Emails are notifications, never the record, and deliberately sparse: the
 * operator is emailed when a conversation NEEDS a person (hand-over, or a
 * user message on a human-handled thread), never for every assistant turn;
 * the user is emailed when a person replies.
 */
import type { HandledBy, MessageAuthor, TicketCategory, TicketStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runAgent } from "@/lib/agent";
import { sendEmail } from "@/lib/adapters/email";
import { baseUrl } from "@/lib/baseUrl";
import { report } from "@/lib/errors";
import { SUPPORT_CATEGORIES, categoryLabel } from "@/lib/support";

export type Actor = { id: string; email: string; role: "user" | "admin" };

/** SessionUser carries `role` as a string; anything not literally "admin" is a user. */
export function actorOf(user: { id: string; email: string; role: string }): Actor {
  return { id: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user" };
}

export type ThreadMessage = { id: string; authorRole: MessageAuthor; body: string; createdAt: string };

export type TicketView = {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  handledBy: HandledBy;
  summary: string | null;
  createdAt: string;
  lastMessageAt: string;
  lastMessageBy: MessageAuthor;
  closedAt: string | null;
  escalatedAt: string | null;
  /** For the viewer: is there something they have not read? */
  unread: boolean;
  user: { id: string; email: string; name: string | null };
  messages: ThreadMessage[];
};

/* ── reading ─────────────────────────────────────────────────────── */

function viewOf(
  t: {
    id: string; category: TicketCategory; subject: string; status: TicketStatus;
    handledBy: HandledBy; summary: string | null; createdAt: Date; lastMessageAt: Date;
    lastMessageBy: MessageAuthor; closedAt: Date | null; escalatedAt: Date | null;
    userSeenAt: Date | null; adminSeenAt: Date | null;
    user: { id: string; email: string; name: string | null };
    messages: { id: string; authorRole: MessageAuthor; body: string; createdAt: Date }[];
  },
  actor: Actor,
): TicketView {
  const seenAt = actor.role === "admin" ? t.adminSeenAt : t.userSeenAt;
  // Unread for the operator: the thread is with the team and someone other
  // than the team spoke last (the user, or the assistant's hand-over note) and
  // nobody on our side has opened it since. Unread for the user: a person or
  // the assistant replied since they last looked.
  const unread =
    actor.role === "admin"
      ? t.handledBy === "human" && t.lastMessageBy !== "admin" && (!seenAt || seenAt < t.lastMessageAt)
      : t.lastMessageBy !== "user" && (!seenAt || seenAt < t.lastMessageAt);
  return {
    id: t.id,
    category: t.category,
    subject: t.subject,
    status: t.status,
    handledBy: t.handledBy,
    summary: t.summary,
    createdAt: t.createdAt.toISOString(),
    lastMessageAt: t.lastMessageAt.toISOString(),
    lastMessageBy: t.lastMessageBy,
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    escalatedAt: t.escalatedAt ? t.escalatedAt.toISOString() : null,
    unread,
    user: t.user,
    messages: t.messages.map((m) => ({
      id: m.id,
      authorRole: m.authorRole,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

/** The conversation, if this actor may see it — owner or admin. */
export async function loadTicket(id: string, actor: Actor): Promise<TicketView | null> {
  const t = await prisma.ticket.findFirst({
    where: actor.role === "admin" ? { id } : { id, userId: actor.id },
    include: {
      user: { select: { id: true, email: true, name: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  return t ? viewOf(t, actor) : null;
}

/** Mark the thread read by this side. Idempotent; safe to call on every open. */
export async function markSeen(id: string, actor: Actor): Promise<void> {
  const data = actor.role === "admin" ? { adminSeenAt: new Date() } : { userSeenAt: new Date() };
  await prisma.ticket
    .updateMany({ where: actor.role === "admin" ? { id } : { id, userId: actor.id }, data })
    .catch(() => null);
}

/* ── the assistant ───────────────────────────────────────────────── */

/** What the assistant is allowed to know about the product — one source. */
function knowledge(): string {
  const lines: string[] = [];
  for (const c of SUPPORT_CATEGORIES) {
    if (!c.selfHelp.length) continue;
    lines.push(`${c.label}:`);
    for (const h of c.selfHelp) lines.push(`  - ${h}`);
  }
  lines.push("Refund policy is at /refunds; a person reads every handed-over conversation.");
  lines.push("Every run that produced nothing was refunded automatically — no one is charged for a failure.");
  return lines.join("\n");
}

/** A few true facts about this account, so the assistant does not guess them. */
async function userContext(userId: string): Promise<string> {
  const [u, resumes, lastRun] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { plan: true, planExpiresAt: true, accessStatus: true, createdAt: true },
    }),
    prisma.resume.count({ where: { userId } }),
    prisma.variantRun.findFirst({
      where: { userId },
      orderBy: { startedAt: "desc" },
      select: { status: true, error: true, targetName: true, startedAt: true },
    }),
  ]);
  if (!u) return "";
  const parts = [
    `plan: ${u.plan}${u.planExpiresAt ? ` (expires ${u.planExpiresAt.toISOString().slice(0, 10)})` : ""}`,
    `access: ${u.accessStatus}`,
    `resumes uploaded: ${resumes}`,
    `member since: ${u.createdAt.toISOString().slice(0, 10)}`,
  ];
  if (lastRun) {
    parts.push(
      `last rebuild: ${lastRun.status}${lastRun.targetName ? ` for ${lastRun.targetName}` : ""}` +
        `${lastRun.error ? ` — "${lastRun.error.slice(0, 140)}"` : ""} (${lastRun.startedAt.toISOString().slice(0, 16)} UTC)`,
    );
  }
  return parts.join("; ");
}

type AssistantTurn = {
  reply: string;
  summary: string;
  category: TicketCategory;
  subject: string;
  escalate: boolean;
  fallback: boolean;
};

async function askAssistant(ticketId: string, userId: string): Promise<AssistantTurn> {
  const msgs = await prisma.ticketMessage.findMany({
    where: { ticketId },
    orderBy: { createdAt: "asc" },
    select: { authorRole: true, body: true },
  });
  const res = await runAgent<{
    reply: string; summary: string; category: string; subject: string; escalate: boolean; fallback: boolean;
  }>("support_chat", {
    messages: msgs.map((m) => ({ role: m.authorRole, content: m.body })),
    knowledge: knowledge(),
    user_context: await userContext(userId),
  });
  if (!res.ok) {
    report({ source: "agent", kind: "support-assistant-failed", message: res.error, context: `ticket:${ticketId}` });
    const last = [...msgs].reverse().find((m) => m.authorRole === "user")?.body ?? "";
    return {
      reply:
        "I couldn't reach my own brain just now, so I won't guess. I've passed this conversation to a person on the Grindly team — they will reply right here and you will get an email when they do.",
      summary: `Assistant unavailable. User wrote: ${last.slice(0, 300)}`,
      category: "other",
      subject: last.slice(0, 60) || "Support request",
      escalate: true,
      fallback: true,
    };
  }
  const valid = new Set(SUPPORT_CATEGORIES.map((c) => c.key));
  return {
    reply: res.reply,
    summary: res.summary,
    category: (valid.has(res.category as TicketCategory) ? res.category : "other") as TicketCategory,
    subject: res.subject,
    escalate: Boolean(res.escalate),
    fallback: Boolean(res.fallback),
  };
}

/**
 * Run one assistant turn on a conversation it is still handling: store its
 * reply, refresh the operator's summary/category/subject, and hand over if
 * it said so. Safe to call after every user message — it checks `handledBy`
 * itself and does nothing once a person has the thread.
 */
async function assistantTurn(ticketId: string, userId: string, userEmail: string): Promise<void> {
  const t = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { handledBy: true, status: true, subject: true, summary: true },
  });
  if (!t || t.handledBy !== "assistant" || t.status === "closed") return;

  const turn = await askAssistant(ticketId, userId);
  const now = new Date();
  // Keep a subject the assistant named, else the placeholder the first
  // message gave it; never let a blank overwrite a good one.
  const subject = turn.subject && turn.subject.length >= 4 ? turn.subject : t.subject;
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: { ticketId, authorRole: "assistant", body: turn.reply },
    }),
    prisma.ticket.update({
      where: { id: ticketId },
      data: {
        lastMessageAt: now,
        lastMessageBy: "assistant",
        summary: turn.summary || t.summary,
        category: turn.category,
        subject,
        ...(turn.escalate
          ? { handledBy: "human", escalatedAt: now, status: "open" }
          : {}),
      },
    }),
  ]);
  if (turn.escalate) {
    void notifyAdmins(ticketId, subject, turn.category, turn.summary || turn.reply, userEmail, "handed over");
  }
}

/* ── writing ─────────────────────────────────────────────────────── */

/**
 * Start a conversation with the user's first message. The assistant answers
 * before this returns, so the page shows a reply immediately — the person
 * wrote to someone, not into a form.
 */
export async function startConversation(actor: Actor, firstMessage: string): Promise<TicketView> {
  const t = await prisma.ticket.create({
    data: {
      userId: actor.id,
      category: "other",
      subject: firstMessage.replace(/\s+/g, " ").trim().slice(0, 60),
      status: "open",
      handledBy: "assistant",
      lastMessageBy: "user",
      userSeenAt: new Date(),
      messages: { create: { authorRole: "user", authorId: actor.id, body: firstMessage } },
    },
    select: { id: true },
  });
  await assistantTurn(t.id, actor.id, actor.email);
  return (await loadTicket(t.id, actor))!;
}

/**
 * Append a message. A user's message on an assistant-handled thread gets an
 * assistant reply; on a human-handled thread it reopens the ticket and tells
 * the team. An operator's reply takes the thread over for good, sets it
 * Answered and emails the user.
 */
export async function addMessage(id: string, actor: Actor, body: string): Promise<TicketView | null> {
  const existing = await loadTicket(id, actor);
  if (!existing) return null;
  const now = new Date();
  const isAdmin = actor.role === "admin";
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: { ticketId: id, authorRole: isAdmin ? "admin" : "user", authorId: actor.id, body },
    }),
    prisma.ticket.update({
      where: { id },
      data: {
        lastMessageAt: now,
        lastMessageBy: isAdmin ? "admin" : "user",
        status: isAdmin ? "answered" : "open",
        closedAt: null,
        ...(isAdmin ? { adminSeenAt: now, handledBy: "human" } : { userSeenAt: now }),
      },
    }),
  ]);
  if (isAdmin) {
    void notifyUser(existing.user.email, id, existing.subject, body);
  } else if (existing.handledBy === "assistant") {
    await assistantTurn(id, existing.user.id, existing.user.email);
  } else {
    void notifyAdmins(id, existing.subject, existing.category, body, actor.email, "reply");
  }
  return loadTicket(id, actor);
}

/** The user asks for a person. The assistant says goodbye; the team is told. */
export async function requestHuman(id: string, actor: Actor): Promise<TicketView | null> {
  const existing = await loadTicket(id, actor);
  if (!existing) return null;
  if (existing.handledBy === "human") return existing;
  const now = new Date();
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorRole: "assistant",
        body: "Passing this to a person on the Grindly team now. They will reply right here, and you will get an email when they do.",
      },
    }),
    prisma.ticket.update({
      where: { id },
      data: { handledBy: "human", escalatedAt: now, status: "open", lastMessageAt: now, lastMessageBy: "assistant" },
    }),
  ]);
  void notifyAdmins(id, existing.subject, existing.category, existing.summary ?? "(no summary yet)", actor.email, "asked for a person");
  return loadTicket(id, actor);
}

export async function closeTicket(id: string, actor: Actor): Promise<boolean> {
  const r = await prisma.ticket.updateMany({
    where: actor.role === "admin" ? { id } : { id, userId: actor.id },
    data: { status: "closed", closedAt: new Date() },
  });
  return r.count > 0;
}

/* ── notifications (best-effort) ─────────────────────────────────── */

async function adminEmails(): Promise<string[]> {
  const rows = await prisma.user
    .findMany({ where: { role: "admin", deletedAt: null }, select: { email: true } })
    .catch(() => []);
  return rows.map((r) => r.email).filter(Boolean);
}

async function notifyAdmins(
  ticketId: string,
  subject: string,
  category: TicketCategory,
  body: string,
  from: string,
  why: string,
): Promise<void> {
  const to = await adminEmails();
  if (!to.length) return;
  const link = `${baseUrl()}/admin?s=tickets&t=${ticketId}`;
  const text =
    `A conversation needs a person (${why}) — from ${from}\n` +
    `About: ${categoryLabel(category)}\n` +
    `Subject: ${subject}\n\n` +
    `${body.slice(0, 1500)}${body.length > 1500 ? "\n…" : ""}\n\n` +
    `Open: ${link}\n`;
  await Promise.all(
    to.map((addr) =>
      sendEmail({ to: addr, subject: `[Grindly support] ${subject.slice(0, 80)}`, body: text }).catch((e) =>
        console.error("[tickets] admin notify failed:", (e as Error).message),
      ),
    ),
  );
}

async function notifyUser(to: string, ticketId: string, subject: string, body: string): Promise<void> {
  const link = `${baseUrl()}/app/support/${ticketId}`;
  await sendEmail({
    to,
    subject: `Grindly support replied: ${subject.slice(0, 80)}`,
    body:
      `A person on the Grindly team replied to "${subject}":\n\n` +
      `${body.slice(0, 1500)}${body.length > 1500 ? "\n…" : ""}\n\n` +
      `Read and reply here: ${link}\n\n— Grindly`,
  }).catch((e) => console.error("[tickets] user notify failed:", (e as Error).message));
}
