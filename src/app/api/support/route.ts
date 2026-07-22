import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import type { SupportMsg } from "@/lib/supportAI";

export const dynamic = "force-dynamic";

/**
 * Resume the user's current support conversation (their one open ticket) so the
 * chat modal reopens where they left off. Returns { ticket: null } for a first-
 * time visitor — the client shows a local greeting until they send anything.
 */
export async function GET() {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const ticket = await prisma.supportTicket.findFirst({
    where: { userId: uid, status: "open" },
    orderBy: { updatedAt: "desc" },
    select: { id: true, messagesJson: true },
  });
  if (!ticket) return NextResponse.json({ ticket: null });

  let messages: SupportMsg[] = [];
  try {
    const arr = JSON.parse(ticket.messagesJson);
    if (Array.isArray(arr)) messages = arr;
  } catch {
    // corrupt payload — treat as an empty thread rather than 500
  }

  return NextResponse.json({ ticket: { id: ticket.id, messages } });
}
