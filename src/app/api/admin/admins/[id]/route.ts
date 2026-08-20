import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, badRequest, notFound, serverError } from "@/lib/auth";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Take admin back off an account.
 *
 * Refuses to remove the last admin standing. Every other mistake this page
 * can make is one more click to undo; locking every operator out of the
 * console that undoes mistakes is not, and there is no self-service way back
 * in short of `scripts/make-admin.mjs` on the server itself.
 */
export async function POST(_req: Request, { params }: Ctx) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, email: true, role: true } });
  if (!target || target.role !== "admin") return notFound();

  const adminCount = await prisma.user.count({ where: { role: "admin" } });
  if (adminCount <= 1) {
    return badRequest("That is the last admin account. Promote someone else first.");
  }

  try {
    await prisma.user.update({ where: { id: target.id }, data: { role: "user" } });
  } catch (e) {
    return serverError("Could not update that account.", `admin/admins/${id}: ${String(e)}`);
  }

  await audit(auth.user.id, "admin_revoke", target.id, target.email);
  return NextResponse.json({ ok: true });
}
