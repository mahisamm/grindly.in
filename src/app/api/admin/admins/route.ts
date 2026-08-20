import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin, badRequest, notFound, serverError } from "@/lib/auth";
import { normalizeEmail } from "@/lib/password";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Grant admin to an existing account, by email.
 *
 * Does not create the account — the person has to have signed up first. That
 * is deliberate: this button hands out the same role the operator has, and
 * typing an email that has never signed in should not be the thing that
 * conjures a new admin account into existence.
 */
export async function POST(req: Request) {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const body = await req.json().catch(() => null);
  const email = normalizeEmail(typeof body?.email === "string" ? body.email : "");
  if (!email) return badRequest("Send the email of an existing account.");

  const target = await prisma.user.findUnique({ where: { email }, select: { id: true, role: true } });
  if (!target) return notFound();
  if (target.role === "admin") {
    return NextResponse.json({ ok: true, alreadyAdmin: true });
  }

  try {
    await prisma.user.update({ where: { id: target.id }, data: { role: "admin" } });
  } catch (e) {
    return serverError("Could not update that account.", `admin/admins: ${String(e)}`);
  }

  await audit(auth.user.id, "admin_promote", target.id, email);
  return NextResponse.json({ ok: true });
}
