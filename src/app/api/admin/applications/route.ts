import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// "Which applications were matched to which user" is the question this endpoint
// exists to answer, so it serves two shapes of the same data:
//   default        — the flat, filterable list (optionally scoped to one user)
//   ?groupBy=user  — one row per user with their per-status counts
// The grouped mode aggregates in the database rather than pulling every row and
// counting in JS: with a few thousand applications the flat list would page, and
// a per-user total computed from one page would be silently wrong.
export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const { searchParams } = new URL(req.url);
  // `|| 1` is load-bearing. `?page=abc` returns the string "abc", so `?? 1`
  // never fires, Number("abc") is NaN, Math.max(1, NaN) is NaN — and that NaN
  // flowed straight into `skip:` below. Matches the parse the other admin
  // list routes already use.
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const status = searchParams.get("status") ?? "";
  const platform = searchParams.get("platform") ?? "";
  const userId = searchParams.get("userId") ?? "";
  const q = searchParams.get("q") ?? "";
  const PAGE_SIZE = 50;

  if (searchParams.get("groupBy") === "user") {
    return groupedByUser(q);
  }

  const where: Record<string, unknown> = {};
  if (status) where.status = status;
  if (platform) where.job = { source: platform };
  if (userId) where.userId = userId;
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
        failureReason: true, outcome: true, appliedAt: true, createdAt: true, url: true,
        user: { select: { id: true, email: true } },
        job: { select: { source: true } },
      },
    }),
  ]);

  return NextResponse.json({
    // Floor of 1, like the other admin list routes: an empty result set is
    // page 1 of 1, not page 1 of 0.
    page, totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)), total, applications,
  });
}

/** One row per user: totals by status, plus when they were last active. */
async function groupedByUser(q: string) {
  // Group on (userId, status) — one query for every count we need. Prisma has no
  // FILTER-clause support, so the statuses are pivoted in JS afterwards; the row
  // count here is users×statuses (tens), not applications (thousands).
  const grouped = await prisma.application.groupBy({
    by: ["userId", "status"],
    _count: { _all: true },
  });

  const userIds = [...new Set(grouped.map((r) => r.userId))];
  const users = await prisma.user.findMany({
    where: q.trim()
      ? { id: { in: userIds }, OR: [{ email: { contains: q.trim() } }, { name: { contains: q.trim() } }] }
      : { id: { in: userIds } },
    select: { id: true, email: true, name: true, plan: true, accessStatus: true },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  // Most recent activity per user, for sorting by "who is actually using this".
  const latest = await prisma.application.groupBy({
    by: ["userId"],
    _max: { createdAt: true },
  });
  const lastById = new Map(latest.map((r) => [r.userId, r._max.createdAt]));

  const rows = new Map<string, {
    userId: string; email: string; name: string | null; plan: string; accessStatus: string;
    total: number; matched: number; applied: number; failed: number; skipped: number;
    lastActivity: Date | null;
  }>();

  for (const r of grouped) {
    const u = byId.get(r.userId);
    if (!u) continue; // filtered out by the search, or a deleted account
    const row = rows.get(r.userId) ?? {
      userId: r.userId, email: u.email, name: u.name, plan: u.plan, accessStatus: u.accessStatus,
      total: 0, matched: 0, applied: 0, failed: 0, skipped: 0,
      lastActivity: lastById.get(r.userId) ?? null,
    };
    const n = r._count._all;
    row.total += n;
    if (r.status === "matched" || r.status === "approved") row.matched += n;
    else if (r.status === "applied") row.applied += n;
    else if (r.status === "failed") row.failed += n;
    else if (r.status === "skipped") row.skipped += n;
    rows.set(r.userId, row);
  }

  const users_ = [...rows.values()].sort(
    (a, b) => (b.lastActivity?.getTime() ?? 0) - (a.lastActivity?.getTime() ?? 0),
  );

  return NextResponse.json({ groupBy: "user", users: users_, total: users_.length });
}
