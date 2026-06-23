import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// Fleet integration health. Surfaces accounts whose sessions need attention
// (needs_login / connecting) first — those block the agent from applying.
export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  let rows: {
    platform: string; status: string; connectedAt: Date | null; updatedAt: Date;
    user: { id: string; email: string } | null;
  }[] = [];
  try {
    rows = await prisma.userIntegration.findMany({
      orderBy: { updatedAt: "desc" },
      select: {
        platform: true, status: true, connectedAt: true, updatedAt: true,
        user: { select: { id: true, email: true } },
      },
    });
  } catch {
    rows = []; // table not migrated yet
  }

  const summary: Record<string, number> = {};
  for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1;

  // sessions that need attention bubble to the top
  const priority = (s: string) => (s === "needs_login" ? 0 : s === "connecting" ? 1 : s === "connected" ? 2 : 3);

  return NextResponse.json({
    summary,
    integrations: rows
      .map((r) => ({
        userId: r.user?.id ?? null,
        email: r.user?.email ?? "—",
        platform: r.platform,
        status: r.status,
        connectedAt: r.connectedAt,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => priority(a.status) - priority(b.status)),
  });
}
