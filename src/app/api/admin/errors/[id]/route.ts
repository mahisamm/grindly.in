import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Mark an error as dealt with, or put it back.
 *
 * The admin page lists unresolved errors and had no way to stop listing one, so
 * a fault fixed in March would still be at the top of the page in August and
 * the table stopped being read. Resolving is not deleting: the row stays, the
 * retention sweep collects it thirty days later, and if the same fingerprint
 * fires again `recordError` clears `resolvedAt` and it comes straight back.
 * That last part matters — "I fixed this" and "this stopped happening" are
 * different claims, and only the second one is evidence.
 */
export async function POST(req: Request, { params }: Ctx) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  let body: { resolved?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // An empty body means resolve — that is the button on the page.
  }
  const resolved = body.resolved !== false;

  try {
    const updated = await prisma.errorEvent.updateMany({
      where: { id },
      data: { resolvedAt: resolved ? new Date() : null },
    });
    if (updated.count === 0) return notFound();
  } catch (e) {
    return serverError("Could not update that error.", `admin/errors/${id}: ${String(e)}`);
  }

  await audit(auth.user.id, resolved ? "error_resolve" : "error_reopen", id);
  return NextResponse.json({ ok: true, resolved });
}
