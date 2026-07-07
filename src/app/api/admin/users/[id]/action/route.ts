import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireAdmin, adminAudit } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Privileged admin mutations against a single user. Every action is written to
// the append-only audit trail with the acting admin's id. Self-targeting role
// changes are blocked so an admin can't lock themselves out.
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("set_paid"), value: z.boolean() }),
  z.object({ action: z.literal("set_plan"), value: z.enum(["free", "starter", "pro"]) }),
  z.object({ action: z.literal("set_role"), value: z.enum(["user", "admin"]) }),
  z.object({ action: z.literal("set_integration_access"), value: z.boolean() }),
  z.object({ action: z.literal("disconnect"), platform: z.string().min(1).max(40) }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;
  const { admin } = g;
  const { id } = await ctx.params;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  const target = await prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  switch (body.action) {
    case "pause":
      await prisma.user.update({ where: { id }, data: { status: "paused" } });
      break;
    case "resume":
      await prisma.user.update({ where: { id }, data: { status: "active" } });
      break;
    case "set_paid":
      await prisma.user.update({ where: { id }, data: { paid: body.value } });
      break;
    case "set_plan":
      await prisma.user.update({ where: { id }, data: { plan: body.value } });
      break;
    case "set_role":
      if (id === admin.id) {
        return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
      }
      await prisma.user.update({ where: { id }, data: { role: body.value } });
      break;
    case "set_integration_access":
      await prisma.user.update({ where: { id }, data: { internshalaBetaAccess: body.value } });
      break;
    case "disconnect":
      await prisma.userIntegration.updateMany({
        where: { userId: id, platform: body.platform },
        data: { status: "disconnected", connectedAt: null },
      });
      break;
  }

  await adminAudit(admin, body.action, id, JSON.stringify(body));
  return NextResponse.json({ ok: true });
}
