import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { normalizePlan } from "@/lib/plans";

export const dynamic = "force-dynamic";

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function GET() {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const since14 = new Date(Date.now() - 14 * 86400_000);
  const todayKey = dayKey(new Date());

  const [users, apps14, allApps, integrations, recentFailures, lastRun, platformApps] = await Promise.all([
    prisma.user.findMany({ select: { paid: true, plan: true, status: true, role: true } }),
    prisma.application.findMany({
      where: { createdAt: { gte: since14 } },
      select: { status: true, createdAt: true, appliedAt: true },
    }),
    prisma.application.count(),
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
    prisma.agentRun.findFirst({
      orderBy: { updatedAt: "desc" },
      select: { status: true, updatedAt: true, createdAt: true, mode: true, error: true },
    }).catch(() => null),
    prisma.application.findMany({
      where: { createdAt: { gte: since14 } },
      select: { status: true, failureReason: true, job: { select: { source: true } } },
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
    // normalizePlan folds the legacy "starter" rows into "plus" — counting the raw
    // column would report them as neither, and the mix wouldn't add up to the total.
    byPlan: {
      free: users.filter((u) => normalizePlan(u.plan) === "free").length,
      plus: users.filter((u) => normalizePlan(u.plan) === "plus").length,
      pro: users.filter((u) => normalizePlan(u.plan) === "pro").length,
    },
  };

  // ── Run KPIs
  const applied14 = apps14.filter((a) => a.status === "applied").length;
  const failed14 = apps14.filter((a) => a.status === "failed").length;
  const matched14 = apps14.length;
  const failRate = applied14 + failed14 ? Math.round((failed14 / (applied14 + failed14)) * 100) : 0;
  const appliedToday = apps14.filter(
    (a) => dayKey(a.appliedAt ?? a.createdAt) === todayKey && a.status === "applied"
  ).length;

  // ── 14-day trend
  const buckets = new Map<string, number>();
  for (let i = 13; i >= 0; i--) buckets.set(dayKey(new Date(Date.now() - i * 86400_000)), 0);
  for (const a of apps14) {
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

  // ── Per-platform fail rates (14d)
  // The three sources that actually populate `jobs`. Rows are dropped below if
  // a source produced nothing, so a retired source disappears on its own.
  const platforms = ["internshala", "atsboards", "websource"];
  const platformStats = platforms.map((p) => {
    const pApps = platformApps.filter((a) => a.job?.source === p || (!a.job && p === "internshala"));
    const pApplied = pApps.filter((a) => a.status === "applied").length;
    const pFailed = pApps.filter((a) => a.status === "failed").length;
    const pRate = pApplied + pFailed ? Math.round((pFailed / (pApplied + pFailed)) * 100) : 0;
    return { platform: p, applied: pApplied, failed: pFailed, failRate: pRate };
  }).filter((p) => p.applied + p.failed > 0);

  // ── Cron / last agent run health
  const cronHealth = lastRun ? {
    lastRunAt: lastRun.updatedAt,
    status: lastRun.status,
    mode: lastRun.mode,
    error: lastRun.error ?? null,
    staleHours: Math.round((Date.now() - new Date(lastRun.updatedAt).getTime()) / 3_600_000),
  } : null;

  return NextResponse.json({
    users: userKpis,
    runs: { matched: matched14, applied: applied14, failed: failed14, failRate, appliedToday, windowDays: 14, allTimeApplied: allApps },
    trend,
    integrationHealth,
    platformStats,
    cronHealth,
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
