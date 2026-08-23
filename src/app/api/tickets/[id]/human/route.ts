import { NextResponse } from "next/server";
import { requireUser, notFound, serverError } from "@/lib/auth";
import { requestHuman, actorOf } from "@/lib/tickets";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** "I'd like a person." The assistant steps aside; the team is told. */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;
  try {
    const ticket = await requestHuman(id, actorOf(auth.user));
    if (!ticket) return notFound();
    await audit(auth.user.id, "ticket_escalated", id, "user asked");
    return NextResponse.json({ ok: true, ticket });
  } catch (e) {
    return serverError("Could not hand this over just now.", `tickets:human:${id}: ${String(e)}`);
  }
}
