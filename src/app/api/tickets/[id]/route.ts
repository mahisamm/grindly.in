import { NextResponse } from "next/server";
import { requireUser, notFound } from "@/lib/auth";
import { loadTicket, markSeen, actorOf } from "@/lib/tickets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** The thread. Opening it marks it read for whichever side is looking. */
export async function GET(_req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const actor = actorOf(auth.user);
  const ticket = await loadTicket(id, actor);
  if (!ticket) return notFound();
  if (ticket.unread) await markSeen(id, actor);
  return NextResponse.json({ ticket: { ...ticket, unread: false } });
}
