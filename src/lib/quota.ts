// Server-side daily quota — never trust the client for limits.
// Mirrors agent/db.py:get_plan_cap + todays_applied_count.

import { prisma } from "./prisma";
import { isRateLimited } from "./rateLimit";
import { localDate, startOfLocalDay } from "./localDay";

// Re-exported so existing `import { planCap } from "@/lib/quota"` call sites keep
// working; the definition itself lives in lib/plans.ts alongside the prices.
export { planCap } from "./plans";
import { normalizePlan, planCap } from "./plans";

/** Midnight of the user's OWN day. This used to be the Node process's local
 * midnight — UTC in the containers — which is 5.5 hours into an Indian user's
 * day, so /api/me's "N of M left today" and the autopilot panel's "sent today"
 * could disagree about the same applications. One boundary now: the user's
 * profile timezone, same as /api/autopilot. */
async function startOfUsersDay(userId: string): Promise<Date> {
  const prof = await prisma.profile
    .findUnique({ where: { userId }, select: { timezone: true } })
    .catch(() => null);
  return startOfLocalDay(prof?.timezone || "Asia/Kolkata");
}

export async function appliedToday(userId: string): Promise<number> {
  return prisma.application.count({
    where: {
      userId,
      status: "applied",
      appliedAt: { gte: await startOfUsersDay(userId) },
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

/** Rows approved TODAY and not yet submitted — capacity already "spoken for"
 * against today's cap even though they haven't flipped to `applied` yet.
 *
 * The reservation has to expire with the day that granted it. This used to count
 * every approved row for all time, and the failure mode was brutal: hardly
 * anyone comes back to tick "yes, I submitted it", so one day of approvals left
 * `pending === cap` permanently and the user could never approve again — the UI
 * said "your daily limit is reached, try again tomorrow" on every tomorrow,
 * forever. The core loop of the product was bricked by its own safety check.
 *
 * A null `approvedAt` means a row approved before this column existed. Those are
 * deliberately NOT counted: they are exactly the rows that jammed the old
 * counter, and refusing to count them is what unsticks an already-stuck account.
 *
 * Bursting past the cap is still prevented downstream — /api/applications/submitted
 * consumes quota atomically via tryConsumeApplyQuota. */
export async function pendingApprovedCount(userId: string): Promise<number> {
  return prisma.application.count({
    where: {
      userId,
      status: "approved",
      approvedAt: { gte: await startOfUsersDay(userId) },
    },
  });
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
  // Key and window both follow the user's day, matching every other "today"
  // count — a UTC-keyed window reset the allowance at 05:30 IST.
  const prof = await prisma.profile
    .findUnique({ where: { userId }, select: { timezone: true } })
    .catch(() => null);
  const tz = prof?.timezone || "Asia/Kolkata";
  const now = new Date();
  const dayStart = startOfLocalDay(tz, now);
  const windowMs = dayStart.getTime() + 24 * 60 * 60 * 1000 - now.getTime();
  const key = `apply_quota:${userId}:${localDate(tz, now)}`;
  const blocked = await isRateLimited(key, cap, windowMs);
  return !blocked;
}
