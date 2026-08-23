import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, badRequest, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { audit } from "@/lib/audit";
import { startConversation, actorOf } from "@/lib/tickets";
import { TICKET_LIMITS } from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The first reply comes from the assistant before this returns — a model
// call — so give it room beyond the default.
export const maxDuration = 90;

/** My conversations, newest activity first. */
export async function GET() {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const rows = await prisma.ticket.findMany({
    where: { userId: auth.user.id },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
    select: {
      id: true, category: true, subject: true, status: true, handledBy: true,
      lastMessageAt: true, lastMessageBy: true, userSeenAt: true, createdAt: true,
    },
  });
  return NextResponse.json({
    tickets: rows.map((t) => ({
      id: t.id,
      category: t.category,
      subject: t.subject,
      status: t.status,
      handledBy: t.handledBy,
      createdAt: t.createdAt.toISOString(),
      lastMessageAt: t.lastMessageAt.toISOString(),
      unread: t.lastMessageBy !== "user" && (!t.userSeenAt || t.userSeenAt < t.lastMessageAt),
    })),
  });
}

/**
 * Start a conversation: one message in, the assistant's first reply out.
 * requireUser, not requireApprovedUser, on purpose: someone stuck in the
 * approval queue or blocked is exactly who needs to reach us.
 */
export async function POST(req: Request) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;

  if (await isRateLimited(`ticket:new:${user.id}`, TICKET_LIMITS.perHour, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "That is a lot of new conversations in an hour. Continue one of your open ones instead." },
      { status: 429 },
    );
  }

  let body: { message?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return badRequest("Send a JSON body.");
  }
  const message = String(body.message ?? "").trim().slice(0, TICKET_LIMITS.message);
  if (message.length < 3) return badRequest("Write what is going on first.");

  try {
    const ticket = await startConversation(actorOf(user), message);
    await audit(user.id, "ticket_opened", ticket.id, ticket.category);
    return NextResponse.json({ ok: true, id: ticket.id, ticket });
  } catch (e) {
    return serverError("Could not start the conversation.", `tickets:create:${user.id}: ${String(e)}`);
  }
}
