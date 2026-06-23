import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

// Filterable view over the append-only audit trail.
// ?action=<substr> &userId=<id> &page=<n>
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const url = new URL(req.url);
  const action = (url.searchParams.get("action") ?? "").trim();
  const userId = (url.searchParams.get("userId") ?? "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const where: Record<string, unknown> = {};
  if (action) where.action = { contains: action };
  if (userId) where.userId = userId;

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, action: true, target: true, detail: true, createdAt: true,
        user: { select: { email: true } },
      },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    logs: rows.map((r) => ({
      id: r.id,
      action: r.action,
      target: r.target,
      detail: r.detail,
      email: r.user?.email ?? null,
      createdAt: r.createdAt,
    })),
  });
}
