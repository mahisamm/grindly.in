// Server-side daily quota — never trust the client for limits.
// Mirrors agent/db.py:get_plan_cap + todays_applied_count.

import { prisma } from "./prisma";

// Re-exported so existing `import { planCap } from "@/lib/quota"` call sites keep
// working; the definition itself lives in lib/plans.ts alongside the prices.
export { planCap } from "./plans";
import { planCap } from "./plans";

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
      createdAt: { gte: new Date(startOfTodayMs()) },
    },
  });
}

export async function remainingToday(userId: string, plan?: string | null): Promise<number> {
  const cap = planCap(plan);
  const used = await appliedToday(userId);
  return Math.max(0, cap - used);
}
