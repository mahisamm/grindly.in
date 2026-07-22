import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, adminAudit } from "@/lib/admin";

export const dynamic = "force-dynamic";

const schema = z.object({ action: z.enum(["resolve", "reopen"]) });

// Resolve or reopen a support ticket. Every change is written to the audit trail
// with the acting admin's id, mirroring /api/admin/users/[id]/action.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;
  const { admin } = g;
  const { id } = await ctx.params;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const ticket = await prisma.supportTicket.findUnique({ where: { id }, select: { id: true } });
  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const status = parsed.data.action === "resolve" ? "resolved" : "open";
  await prisma.supportTicket.update({ where: { id }, data: { status } });
  await adminAudit(admin, `support_${parsed.data.action}`, id, JSON.stringify(parsed.data));

  return NextResponse.json({ ok: true, status });
}
