import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireApprovedUser, badRequest, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const STATUSES = ["sent", "screening", "interview", "offer", "rejected", "withdrawn"] as const;
type Status = (typeof STATUSES)[number];

function isStatus(value: unknown): value is Status {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

/** Move an application along, or correct it. */
export async function PATCH(req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { status?: unknown; notes?: unknown };
  try {
    body = await req.json();
  } catch {
    return badRequest("Send a JSON body.");
  }

  const data: { status?: Status; notes?: string | null } = {};
  if (body.status !== undefined) {
    if (!isStatus(body.status)) return badRequest("That is not a status we track.");
    data.status = body.status;
  }
  if (body.notes !== undefined) {
    data.notes = String(body.notes ?? "").trim().slice(0, 2000) || null;
  }
  if (!Object.keys(data).length) return badRequest("Nothing to change.");

  try {
    const updated = await prisma.application.updateMany({
      where: { id, userId: auth.user.id },
      data,
    });
    if (updated.count === 0) return notFound();
  } catch (e) {
    return serverError("Could not update that.", `applications/${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "application_updated", id, data.status ?? "notes");
  return NextResponse.json({ ok: true });
}

/** Remove one. No confirmation: it is a row the user typed, and re-typing it is
 *  a few seconds. The destructive actions worth guarding are the ones that take
 *  documents with them. */
export async function DELETE(_req: Request, { params }: Ctx) {
  const auth = await requireApprovedUser();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const deleted = await prisma.application.deleteMany({
    where: { id, userId: auth.user.id },
  });
  if (deleted.count === 0) return notFound();

  await audit(auth.user.id, "application_deleted", id);
  return NextResponse.json({ ok: true });
}
