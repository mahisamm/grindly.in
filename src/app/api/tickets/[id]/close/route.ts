import { NextResponse } from "next/server";
import { requireUser, notFound } from "@/lib/auth";
import { closeTicket, actorOf } from "@/lib/tickets";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Close — by the owner ("solved, thanks") or the operator. A user reply reopens. */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;
  const ok = await closeTicket(id, actorOf(auth.user));
  if (!ok) return notFound();
  await audit(auth.user.id, "ticket_closed", id, auth.user.role);
  return NextResponse.json({ ok: true });
}
