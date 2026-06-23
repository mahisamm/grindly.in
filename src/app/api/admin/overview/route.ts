import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// Fleet overview: KPIs, 14-day applied trend, recent failures, integration health.
export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const since14 = new Date(Date.now() - 14 * 86400_000);
  const todayKey = dayKey(new Date());

  const [users, apps, integrations, recentFailures] = await Promise.all([
    prisma.user.findMany({ select: { paid: true, plan: true, status: true, role: true } }),
    prisma.application.findMany({
      where: { createdAt: { gte: since14 } },
      select: { status: true, createdAt: true, appliedAt: true },
    }),
    prisma.userIntegration.findMany({ select: { status: true } }).catch(() => []),
    prisma.application.findMany({
      where: { status: "failed" },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true, jobTitle: true, company: true, failureReason: true, reason: true,
        createdAt: true, user: { select: { id: true, email: true } },
      },
    }),
  ]);

  // ── User KPIs
  const userKpis = {
    total: users.length,
    active: users.filter((u) => u.status === "active").length,
    paused: users.filter((u) => u.status === "paused").length,
    paid: users.filter((u) => u.paid).length,
    free: users.filter((u) => !u.paid).length,
    admins: users.filter((u) => u.role === "admin").length,
    byPlan: {
      free: users.filter((u) => u.plan === "free").length,
      starter: users.filter((u) => u.plan === "starter").length,
      pro: users.filter((u) => u.plan === "pro").length,
    },
  };

  // ── Run KPIs (14-day window)
  const applied = apps.filter((a) => a.status === "applied").length;
  const failed = apps.filter((a) => a.status === "failed").length;
  const matched = apps.length;
  const failRate = applied + failed ? Math.round((failed / (applied + failed)) * 100) : 0;
  const appliedToday = apps.filter(
    (a) => dayKey(a.appliedAt ?? a.createdAt) === todayKey && a.status === "applied"
  ).length;

  // ── 14-day applied-per-day trend (oldest → newest)
  const buckets = new Map<string, number>();
  for (let i = 13; i >= 0; i--) buckets.set(dayKey(new Date(Date.now() - i * 86400_000)), 0);
  for (const a of apps) {
    if (a.status !== "applied") continue;
    const k = dayKey(a.appliedAt ?? a.createdAt);
    if (buckets.has(k)) buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const trend = [...buckets.entries()].map(([date, count]) => ({ date, count }));

  // ── Integration health
  const integrationHealth = {
    connected: integrations.filter((i) => i.status === "connected").length,
    needsLogin: integrations.filter((i) => i.status === "needs_login").length,
    disconnected: integrations.filter((i) => i.status === "disconnected").length,
    connecting: integrations.filter((i) => i.status === "connecting").length,
  };

  return NextResponse.json({
    users: userKpis,
    runs: { matched, applied, failed, failRate, appliedToday, windowDays: 14 },
    trend,
    integrationHealth,
    recentFailures: recentFailures.map((f) => ({
      id: f.id,
      userId: f.user?.id ?? null,
      email: f.user?.email ?? "—",
      jobTitle: f.jobTitle,
      company: f.company,
      reason: f.failureReason ?? f.reason ?? "unknown",
      createdAt: f.createdAt,
    })),
  });
}
