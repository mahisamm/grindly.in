import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";
import { createTicket, actorOf } from "@/lib/tickets";
import { SUPPORT_CATEGORIES, TICKET_LIMITS } from "@/lib/support";
import type { TicketCategory } from "@prisma/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** My tickets, newest activity first. */
export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const rows = await prisma.ticket.findMany({
    where: { userId: auth.user.id },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: {
      id: true, category: true, subject: true, status: true,
      lastMessageAt: true, lastMessageBy: true, userSeenAt: true, createdAt: true,
    },
  });
  return NextResponse.json({
    tickets: rows.map((t) => ({
      id: t.id,
      category: t.category,
      subject: t.subject,
      status: t.status,
      createdAt: t.createdAt.toISOString(),
      lastMessageAt: t.lastMessageAt.toISOString(),
      unread: t.lastMessageBy === "admin" && (!t.userSeenAt || t.userSeenAt < t.lastMessageAt),
    })),
  });
}

/**
 * Raise a ticket. requireUser, not requireApprovedUser, on purpose: someone
 * stuck in the approval queue or blocked is exactly who needs to reach us.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  if (await isRateLimited(`ticket:new:${user.id}`, TICKET_LIMITS.perHour, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "That is a lot of tickets in an hour. Reply on an existing one instead." },
      { status: 429 },
    );
  }

  let body: { category?: string; subject?: string; message?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Send a JSON body.");
  }
  const category = SUPPORT_CATEGORIES.find((c) => c.key === body.category)?.key as
    | TicketCategory
    | undefined;
  const subject = String(body.subject ?? "").trim().slice(0, TICKET_LIMITS.subject);
  const message = String(body.message ?? "").trim().slice(0, TICKET_LIMITS.message);
  if (!category) return badRequest("Pick what the ticket is about.");
  if (subject.length < 4) return badRequest("Give the ticket a short subject.");
  if (message.length < 10) return badRequest("Tell us a little more — at least a sentence.");

  try {
    const t = await createTicket(
      actorOf(user),
      { category, subject, message },
    );
    await audit(user.id, "ticket_opened", t.id, category);
    return NextResponse.json({ ok: true, id: t.id });
  } catch (e) {
    return serverError("Could not open the ticket.", `tickets:create:${user.id}: ${String(e)}`);
  }
}
