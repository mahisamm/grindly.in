import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import type { SupportMsg } from "@/lib/supportAI";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

// The support queue. ?status=open|resolved|all (default open) &page=<n>
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") ?? "open").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const where = status === "open" || status === "resolved" ? { status } : {};

  const [total, openCount, rows] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.count({ where: { status: "open" } }),
    prisma.supportTicket.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true, status: true, subject: true, category: true, severity: true,
        summary: true, messagesJson: true, createdAt: true, updatedAt: true,
        user: { select: { email: true, name: true, plan: true } },
      },
    }),
  ]);

  return NextResponse.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    openCount,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    tickets: rows.map((t) => {
      let messages: SupportMsg[] = [];
      try {
        const arr = JSON.parse(t.messagesJson);
        if (Array.isArray(arr)) messages = arr;
      } catch {
        // ignore a corrupt payload — the row's triage fields still render
      }
      return {
        id: t.id,
        status: t.status,
        subject: t.subject,
        category: t.category,
        severity: t.severity,
        summary: t.summary,
        messages,
        email: t.user?.email ?? null,
        name: t.user?.name ?? null,
        plan: t.user?.plan ?? null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      };
    }),
  });
}
