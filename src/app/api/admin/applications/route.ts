import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const { searchParams } = new URL(req.url);
  const page = Math.max(1, Number(searchParams.get("page") ?? 1));
  const status = searchParams.get("status") ?? "";
  const platform = searchParams.get("platform") ?? "";
  const q = searchParams.get("q") ?? "";
  const PAGE_SIZE = 50;

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (platform) where.job = { source: platform };
  if (q.trim()) {
    where.OR = [
      { jobTitle: { contains: q.trim() } },
      { company: { contains: q.trim() } },
      { user: { email: { contains: q.trim() } } },
    ];
  }

  const [total, applications] = await Promise.all([
    prisma.application.count({ where }),
    prisma.application.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, jobTitle: true, company: true, matchScore: true, status: true,
        failureReason: true, outcome: true, appliedAt: true, createdAt: true,
        user: { select: { id: true, email: true } },
        job: { select: { source: true } },
      },
    }),
  ]);

  return NextResponse.json({
    page, totalPages: Math.ceil(total / PAGE_SIZE), total, applications,
  });
}
