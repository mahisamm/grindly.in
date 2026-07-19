import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin";
import { normalizePlan, PLANS, type Plan } from "@/lib/plans";

export const dynamic = "force-dynamic";

const DAY = 86_400_000;
const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

function emptyDays(n: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = n - 1; i >= 0; i--) m.set(dayKey(new Date(Date.now() - i * DAY)), 0);
  return m;
}

export async function GET(req: Request) {
  const g = await requireAdmin();
  if ("error" in g) return g.error;

  const rangeDays = Math.min(90, Math.max(7, Number(new URL(req.url).searchParams.get("days")) || 30));
  const since = new Date(Date.now() - rangeDays * DAY);
  const todayKey = dayKey(new Date());

  const [users, pageViews, uniqueRows, totalViews, payments] = await Promise.all([
    prisma.user.findMany({
      select: { plan: true, paid: true, status: true, accessStatus: true, role: true, createdAt: true },
    }),
    // window of raw views for the daily series + top paths
    prisma.pageView
      .findMany({ where: { createdAt: { gte: since } }, select: { visitorId: true, path: true, createdAt: true } })
      .catch(() => [] as { visitorId: string; path: string; createdAt: Date }[]),
    // all-time distinct visitors
    prisma.pageView.findMany({ distinct: ["visitorId"], select: { visitorId: true } }).catch(() => []),
    prisma.pageView.count().catch(() => 0),
    // revenue: each successful payment is one AuditLog row (action "payment",
    // detail = plan). This is the honest source until a dedicated Payments table.
    prisma.auditLog
      .findMany({ where: { action: "payment" }, select: { detail: true, createdAt: true } })
      .catch(() => [] as { detail: string | null; createdAt: Date }[]),
  ]);

  // ── Visitors
  const viewsByDay = emptyDays(rangeDays);
  const visitorsByDaySet = new Map<string, Set<string>>();
  const pathCounts = new Map<string, number>();
  let todayViews = 0;
  const todayVisitors = new Set<string>();
  for (const v of pageViews) {
    const k = dayKey(v.createdAt);
    if (viewsByDay.has(k)) viewsByDay.set(k, (viewsByDay.get(k) ?? 0) + 1);
    if (!visitorsByDaySet.has(k)) visitorsByDaySet.set(k, new Set());
    visitorsByDaySet.get(k)!.add(v.visitorId);
    pathCounts.set(v.path, (pathCounts.get(v.path) ?? 0) + 1);
    if (k === todayKey) {
      todayViews++;
      todayVisitors.add(v.visitorId);
    }
  }
  const visitorSeries = [...viewsByDay.entries()].map(([date, views]) => ({
    date,
    views,
    visitors: visitorsByDaySet.get(date)?.size ?? 0,
  }));
  const topPaths = [...pathCounts.entries()]
    .map(([path, views]) => ({ path, views }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 8);

  // ── Users
  const plans = { free: 0, plus: 0, pro: 0 };
  const access = { pending: 0, approved: 0, denied: 0 };
  const signupsByDay = emptyDays(rangeDays);
  let active = 0, paused = 0, paid = 0;
  for (const u of users) {
    plans[normalizePlan(u.plan)]++;
    if (u.accessStatus === "pending") access.pending++;
    else if (u.accessStatus === "denied") access.denied++;
    else access.approved++;
    if (u.status === "active") active++;
    if (u.status === "paused") paused++;
    if (u.paid) paid++;
    const k = dayKey(u.createdAt);
    if (signupsByDay.has(k)) signupsByDay.set(k, (signupsByDay.get(k) ?? 0) + 1);
  }
  const signupSeries = [...signupsByDay.entries()].map(([date, count]) => ({ date, count }));

  // ── Revenue (rupees)
  const price = (p: Plan) => PLANS[p].price;
  const rev = { total: 0, plus: 0, pro: 0, plusCount: 0, proCount: 0 };
  const revByDay = emptyDays(rangeDays);
  for (const pmt of payments) {
    const plan = normalizePlan(pmt.detail);
    if (plan === "plus" || plan === "pro") {
      const amt = price(plan);
      rev.total += amt;
      rev[plan] += amt;
      if (plan === "plus") rev.plusCount++;
      else rev.proCount++;
      const k = dayKey(pmt.createdAt);
      if (revByDay.has(k)) revByDay.set(k, (revByDay.get(k) ?? 0) + amt);
    }
  }
  const revenueSeries = [...revByDay.entries()].map(([date, amount]) => ({ date, amount }));

  return NextResponse.json({
    rangeDays,
    visitors: {
      total: totalViews,
      unique: uniqueRows.length,
      todayViews,
      todayVisitors: todayVisitors.size,
      series: visitorSeries,
      topPaths,
    },
    users: {
      total: users.length,
      active,
      paused,
      paid,
      free: users.length - paid,
      byPlan: plans,
      access,
      signupSeries,
    },
    revenue: {
      total: rev.total,
      plus: rev.plus,
      pro: rev.pro,
      plusCount: rev.plusCount,
      proCount: rev.proCount,
      payingUsers: rev.plusCount + rev.proCount,
      series: revenueSeries,
      arpu: paid ? Math.round(rev.total / paid) : 0,
    },
    funnel: {
      visitors: uniqueRows.length,
      signups: users.length,
      approved: access.approved,
      paid,
    },
  });
}
