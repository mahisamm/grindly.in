// Server-side daily quota — never trust the client for limits.
// Mirrors agent/db.py:get_plan_cap + todays_applied_count.

import { prisma } from "./prisma";
import { isRateLimited } from "./rateLimit";

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
  // Free beta: every plan — free included — is a DAILY plan now (free = 5/day,
  // same cap as Plus). There is no lifetime trial any more, so usage is always
  // today's count and it resets each day. "trial" stays in the Quota type for
  // legacy callers but is no longer produced here.
  const kind: Quota["kind"] = "daily";
  const used = await appliedToday(userId);
  return { kind, cap, used, remaining: Math.max(0, cap - used) };
}

export async function remainingToday(userId: string, plan?: string | null): Promise<number> {
  return (await getQuota(userId, plan)).remaining;
}

/** Approved-but-not-yet-submitted rows — capacity already "spoken for" against
 * the daily cap even though they haven't flipped to `applied` yet. Approved
 * rows never expire on their own, so without counting them here a user could
 * call approve/approve-all once per day for many days in a row and bank far
 * more than one day's cap, then burst-submit the backlog past the limit. */
export async function pendingApprovedCount(userId: string): Promise<number> {
  return prisma.application.count({ where: { userId, status: "approved" } });
}

/** Remaining capacity for NEW approvals today — today's cap minus what's
 * already applied today minus what's already approved-and-waiting. */
export async function remainingForApproval(userId: string, plan?: string | null): Promise<number> {
  const [quota, pending] = await Promise.all([getQuota(userId, plan), pendingApprovedCount(userId)]);
  return Math.max(0, quota.remaining - pending);
}

/**
 * Atomically consume one unit of today's apply-quota for a user, returning
 * true iff it was available. Built on the same DB-backed atomic-increment
 * primitive as rateLimit.ts (see its docstring for the exact guarantee) so
 * that concurrent `/api/applications/submitted` calls for the same user can't
 * all read "quota available" before any of them commits — the class of bug
 * that let a burst of concurrent requests push a user's applied-today count
 * past their plan cap.
 */
export async function tryConsumeApplyQuota(userId: string, cap: number): Promise<boolean> {
  if (cap <= 0) return false;
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const windowMs = midnight.getTime() - now.getTime();
  const key = `apply_quota:${userId}:${now.toISOString().slice(0, 10)}`;
  const blocked = await isRateLimited(key, cap, windowMs);
  return !blocked;
}
