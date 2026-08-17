/**
 * Daily ceilings on the operations that cost real compute.
 *
 * A variant batch is several model calls plus up to four headless Chromium
 * renders. Left uncapped, one script can spend an afternoon's worth of free
 * provider quota — which everyone else on the instance then does not have — and
 * pin the box's CPU while doing it.
 *
 * Two properties this implementation has that the obvious one does not:
 *
 *   * It counts in the USER'S local day. "2 a day" has to mean their day, or
 *     the window slides for everyone outside UTC and resets at 5:30am in India.
 *
 *   * It reserves before the work, and refunds if the work never happened. The
 *     natural shape — do the work, then increment — lets a user fire twenty
 *     concurrent requests through the check before any of them has counted.
 */
import { prisma } from "@/lib/prisma";
import { limitsFor, type Limits } from "@/lib/plans";

export type Meter = "variantRuns" | "adviceRuns" | "uploads";

const LIMIT_KEY: Record<Meter, keyof Limits> = {
  variantRuns: "variantRunsPerDay",
  adviceRuns: "adviceRunsPerDay",
  uploads: "uploadsPerDay",
};

const LABEL: Record<Meter, string> = {
  variantRuns: "resume rewrites",
  adviceRuns: "reviews",
  uploads: "uploads",
};

/**
 * The user's local calendar date as YYYY-MM-DD.
 *
 * `en-CA` is used because its short date format IS ISO — `toLocaleDateString`
 * with a timezone is the only way to get "what day is it there" without pulling
 * in a date library, and every other locale needs reformatting afterwards.
 */
export function localDate(timezone = "Asia/Kolkata", now = new Date()): string {
  try {
    return now.toLocaleDateString("en-CA", { timeZone: timezone });
  } catch {
    // An invalid IANA zone from a tampered profile must not 500 a request.
    return now.toLocaleDateString("en-CA", { timeZone: "UTC" });
  }
}

export type QuotaVerdict =
  | { allowed: true; used: number; limit: number; remaining: number }
  | { allowed: false; used: number; limit: number; message: string };

/**
 * Reserve one unit of `meter`. Call BEFORE doing the work.
 *
 * The increment and the read are one atomic statement, so concurrent requests
 * cannot both see "1 used" and both proceed. When the reservation pushes the
 * count past the limit we roll it back and refuse, which means a rejected
 * request does not consume the allowance it was refused for.
 */
export async function reserve(
  userId: string,
  meter: Meter,
  timezone = "Asia/Kolkata",
): Promise<QuotaVerdict> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    // `role` is part of the plan calculation — see `effectivePlan`. Selecting
    // only plan/planExpiresAt here would silently hand an admin the free tier
    // while every page around them showed unlimited.
    select: { plan: true, planExpiresAt: true, role: true },
  });
  if (!user) return { allowed: false, used: 0, limit: 0, message: "Account not found." };

  const limit = limitsFor(user)[LIMIT_KEY[meter]];
  const date = localDate(timezone);

  // Atomic: upsert-then-increment in a single round trip. `update` on the
  // composite unique key maps to one UPDATE ... SET n = n + 1 RETURNING n.
  const row = await prisma.dailyUsage.upsert({
    where: { userId_localDate: { userId, localDate: date } },
    create: { userId, localDate: date, [meter]: 1 },
    update: { [meter]: { increment: 1 } },
  });

  const used = (row as unknown as Record<string, number>)[meter] ?? 0;
  if (used > limit) {
    // Give it back. Without this, every refused attempt still burns a unit, so
    // a user who hits the cap at 10am cannot use the product even after the
    // window they were waiting for — the count keeps climbing.
    await prisma.dailyUsage
      .update({
        where: { userId_localDate: { userId, localDate: date } },
        data: { [meter]: { decrement: 1 } },
      })
      .catch(() => null);
    return {
      allowed: false,
      used: limit,
      limit,
      message:
        limit === 0
          ? `${LABEL[meter]} are not included on your plan.`
          : `You have used all ${limit} ${LABEL[meter]} for today. The limit resets at midnight in your timezone.`,
    };
  }

  return { allowed: true, used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Hand a reserved unit back when the work did not happen — a render that failed
 * on our side, a batch that produced nothing because a provider was down.
 *
 * Charging for those is charging for our own outage.
 */
export async function refund(
  userId: string,
  meter: Meter,
  timezone = "Asia/Kolkata",
): Promise<void> {
  const date = localDate(timezone);
  await prisma.dailyUsage
    .updateMany({
      where: { userId, localDate: date, [meter]: { gt: 0 } },
      data: { [meter]: { decrement: 1 } },
    })
    .catch(() => null);
}

/** Read-only snapshot for the dashboard. Never mutates. */
export async function usageToday(
  userId: string,
  timezone = "Asia/Kolkata",
): Promise<Record<Meter, { used: number; limit: number }>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, planExpiresAt: true, role: true },
  });
  const limits = limitsFor(user ?? {});
  const row = await prisma.dailyUsage.findUnique({
    where: { userId_localDate: { userId, localDate: localDate(timezone) } },
  });
  const meters: Meter[] = ["variantRuns", "adviceRuns", "uploads"];
  const out = {} as Record<Meter, { used: number; limit: number }>;
  for (const m of meters) {
    out[m] = {
      used: (row as unknown as Record<string, number> | null)?.[m] ?? 0,
      limit: limits[LIMIT_KEY[m]],
    };
  }
  return out;
}
