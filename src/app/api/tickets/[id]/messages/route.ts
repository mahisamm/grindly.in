import { NextResponse } from "next/server";
import { requireUser, notFound, badRequest, serverError } from "@/lib/auth";
import { isRateLimited } from "@/lib/rateLimit";
import { addMessage, actorOf } from "@/lib/tickets";
import { TICKET_LIMITS } from "@/lib/support";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A user message may be answered by the assistant before this returns.
export const maxDuration = 90;

type Ctx = { params: Promise<{ id: string }> };

/** Reply on a ticket — as its owner, or as an operator. */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { user } = auth;
  const { id } = await params;

  if (await isRateLimited(`ticket:msg:${user.id}`, TICKET_LIMITS.messagesPerHour, 60 * 60 * 1000)) {
    return NextResponse.json(
      { error: "Slow down a little — try again in a few minutes." },
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
  if (message.length < 1) return badRequest("Write something first.");

  try {
    const ticket = await addMessage(id, actorOf(user), message);
    if (!ticket) return notFound();
    return NextResponse.json({ ok: true, ticket });
  } catch (e) {
    return serverError("Could not send that.", `tickets:message:${id}: ${String(e)}`);
  }
}
