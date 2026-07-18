// Server-side daily quota — never trust the client for limits.
// Mirrors agent/db.py:get_plan_cap + todays_applied_count.

import { prisma } from "./prisma";

// Re-exported so existing `import { planCap } from "@/lib/quota"` call sites keep
// working; the definition itself lives in lib/plans.ts alongside the prices.
export { planCap } from "./plans";
import { normalizePlan, planCap } from "./plans";

function startOfTodayMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function appliedToday(userId: string): Promise<number> {
  return prisma.application.count({
    where: {
      userId,
      status: "applied",
      appliedAt: { gte: new Date(startOfTodayMs()) },
    },
  });
}

export async function appliedTotal(userId: string): Promise<number> {
  return prisma.application.count({ where: { userId, status: "applied" } });
}

export type Quota = {
  kind: "trial" | "daily";
  cap: number;
  used: number;
  remaining: number;
};

export async function getQuota(userId: string, plan?: string | null): Promise<Quota> {
  const normalized = normalizePlan(plan);
  const cap = planCap(normalized);
  const kind = normalized === "free" ? "trial" : "daily";
  const used = kind === "trial" ? await appliedTotal(userId) : await appliedToday(userId);
  return { kind, cap, used, remaining: Math.max(0, cap - used) };
}

export async function remainingToday(userId: string, plan?: string | null): Promise<number> {
  return (await getQuota(userId, plan)).remaining;
}
