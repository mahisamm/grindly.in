/**
 * Support tickets: one conversation between a user and the operator.
 *
 * Access is by OWNERSHIP or ROLE, checked here once, so every route and page
 * that touches a ticket goes through the same gate. A user sees their own; an
 * admin sees all. The "seen" stamps are written when a side READS the thread,
 * which is what drives the unread badges — a message is unread until the
 * other side has actually opened it, not until it was delivered.
 *
 * Emails are best-effort notifications, never the record: the thread in the
 * database is the conversation, the email only says "there is something to
 * read". A failed send is logged and the ticket is untouched.
 */
import type { Role, TicketCategory, TicketStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { sendEmail } from "@/lib/adapters/email";
import { baseUrl } from "@/lib/baseUrl";
import { categoryLabel } from "@/lib/support";

export type Actor = { id: string; email: string; role: Role };

/** SessionUser carries `role` as a string; the ticket code wants the enum.
    Anything that is not literally "admin" is a user — never the other way. */
export function actorOf(user: { id: string; email: string; role: string }): Actor {
  return { id: user.id, email: user.email, role: user.role === "admin" ? "admin" : "user" };
}

export type TicketView = {
  id: string;
  category: TicketCategory;
  subject: string;
  status: TicketStatus;
  createdAt: string;
  lastMessageAt: string;
  lastMessageBy: Role;
  closedAt: string | null;
  /** For the viewer: is there something they have not read? */
  unread: boolean;
  user: { id: string; email: string; name: string | null };
  messages: { id: string; authorRole: Role; body: string; createdAt: string }[];
};

/** The ticket, if this actor may see it — owner or admin. */
export async function loadTicket(id: string, actor: Actor): Promise<TicketView | null> {
  const t = await prisma.ticket.findFirst({
    where: actor.role === "admin" ? { id } : { id, userId: actor.id },
    include: {
      user: { select: { id: true, email: true, name: true } },
      messages: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!t) return null;
  const seenAt = actor.role === "admin" ? t.adminSeenAt : t.userSeenAt;
  const otherSide: Role = actor.role === "admin" ? "user" : "admin";
  const unread = t.lastMessageBy === otherSide && (!seenAt || seenAt < t.lastMessageAt);
  return {
    id: t.id,
    category: t.category,
    subject: t.subject,
    status: t.status,
    createdAt: t.createdAt.toISOString(),
    lastMessageAt: t.lastMessageAt.toISOString(),
    lastMessageBy: t.lastMessageBy,
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
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

/** Mark the thread read by this side. Idempotent; safe to call on every open. */
export async function markSeen(id: string, actor: Actor): Promise<void> {
  const data = actor.role === "admin" ? { adminSeenAt: new Date() } : { userSeenAt: new Date() };
  await prisma.ticket
    .updateMany({ where: actor.role === "admin" ? { id } : { id, userId: actor.id }, data })
    .catch(() => null);
}

export async function createTicket(
  actor: Actor,
  input: { category: TicketCategory; subject: string; message: string },
): Promise<{ id: string }> {
  const t = await prisma.ticket.create({
    data: {
      userId: actor.id,
      category: input.category,
      subject: input.subject,
      status: "open",
      lastMessageBy: "user",
      userSeenAt: new Date(),
      messages: { create: { authorRole: "user", authorId: actor.id, body: input.message } },
    },
    select: { id: true },
  });
  void notifyAdmins(t.id, input.subject, input.category, input.message, actor.email);
  return t;
}

/**
 * Append a message. The status follows who spoke: an operator's reply puts
 * the ball with the user (`answered`); a user's reply — including on a
 * closed ticket, which reopens it — puts it back in the operator's queue.
 */
export async function addMessage(
  id: string,
  actor: Actor,
  body: string,
): Promise<TicketView | null> {
  const existing = await loadTicket(id, actor);
  if (!existing) return null;
  const now = new Date();
  const isAdmin = actor.role === "admin";
  await prisma.$transaction([
    prisma.ticketMessage.create({
      data: { ticketId: id, authorRole: actor.role, authorId: actor.id, body },
    }),
    prisma.ticket.update({
      where: { id },
      data: {
        lastMessageAt: now,
        lastMessageBy: actor.role,
        status: isAdmin ? "answered" : "open",
        closedAt: null,
        ...(isAdmin ? { adminSeenAt: now } : { userSeenAt: now }),
      },
    }),
  ]);
  if (isAdmin) {
    void notifyUser(existing.user.email, id, existing.subject, body);
  } else {
    void notifyAdmins(id, existing.subject, existing.category, body, actor.email, true);
  }
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
  reply = false,
): Promise<void> {
  const to = await adminEmails();
  if (!to.length) return;
  const link = `${baseUrl()}/admin?s=tickets&t=${ticketId}`;
  const text =
    `${reply ? "Reply on" : "New"} ticket from ${from}\n` +
    `Category: ${categoryLabel(category)}\n` +
    `Subject: ${subject}\n\n` +
    `${body.slice(0, 1500)}${body.length > 1500 ? "\n…" : ""}\n\n` +
    `Open: ${link}\n`;
  await Promise.all(
    to.map((addr) =>
      sendEmail({
        to: addr,
        subject: `[Grindly support] ${reply ? "Reply" : "New ticket"}: ${subject.slice(0, 80)}`,
        body: text,
      }).catch((e) => console.error("[tickets] admin notify failed:", (e as Error).message)),
    ),
  );
}

async function notifyUser(to: string, ticketId: string, subject: string, body: string): Promise<void> {
  const link = `${baseUrl()}/app/support/${ticketId}`;
  await sendEmail({
    to,
    subject: `Grindly support replied: ${subject.slice(0, 80)}`,
    body:
      `We replied to your ticket "${subject}":\n\n` +
      `${body.slice(0, 1500)}${body.length > 1500 ? "\n…" : ""}\n\n` +
      `Read and reply here: ${link}\n\n— Grindly`,
  }).catch((e) => console.error("[tickets] user notify failed:", (e as Error).message));
}
