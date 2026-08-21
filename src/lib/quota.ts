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
 *     That was a promise the code did not keep for a while. Every function here
 *     took a `timezone` parameter with an Asia/Kolkata default and not one
 *     caller ever passed it, so every account on the instance was counted in
 *     IST while the refusal message told them the limit resets at midnight in
 *     their timezone. The zone is now a column on the user, captured from the
 *     browser at sign-in, and read here rather than passed in — a default
 *     parameter that every caller silently accepts is not a default, it is the
 *     only behaviour.
 *
 *   * It reserves before the work, and refunds if the work never happened. The
 *     natural shape — do the work, then increment — lets a user fire twenty
 *     concurrent requests through the check before any of them has counted.
 */
import { prisma } from "@/lib/prisma";
import { effectivePlan, limitsFor, type Limits } from "@/lib/plans";

export type Meter = "variantRuns" | "adviceRuns" | "uploads";

/**
 * Where a user is counted when we have not been told otherwise.
 *
 * India, because that is who this is built for — not UTC, which would be a
 * neutral-looking choice that is wrong for almost every actual user.
 */
export const DEFAULT_TIMEZONE = "Asia/Kolkata";

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
export function localDate(timezone = DEFAULT_TIMEZONE, now = new Date()): string {
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
export async function reserve(userId: string, meter: Meter): Promise<QuotaVerdict> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    // `role` is part of the plan calculation — see `effectivePlan`. Selecting
    // only plan/planExpiresAt here would silently hand an admin the free tier
    // while every page around them showed unlimited.
    select: { plan: true, planExpiresAt: true, role: true, timezone: true },
  });
  if (!user) return { allowed: false, used: 0, limit: 0, message: "Account not found." };

  const limit = limitsFor(user)[LIMIT_KEY[meter]];
  const date = localDate(user.timezone ?? DEFAULT_TIMEZONE);
  // Free accounts spend a LIFETIME allowance on the model-priced meters, not a
  // daily one. The daily reset taught patient users to wait for midnight and
  // never pay — the operator's explicit objection to the old shape. Uploads
  // stay daily for everyone: they cost local parsing, not provider quota, and
  // a lifetime upload cap would strand someone who iterates on their file.
  const lifetime = meter !== "uploads" && effectivePlan(user) === "free";

  // Atomic: upsert-then-increment in a single round trip. `update` on the
  // composite unique key maps to one UPDATE ... SET n = n + 1 RETURNING n.
  const row = await prisma.dailyUsage.upsert({
    where: { userId_localDate: { userId, localDate: date } },
    create: { userId, localDate: date, [meter]: 1 },
    update: { [meter]: { increment: 1 } },
  });

  // Lifetime = the SUM across every daily row, today's increment included.
  // The increment still lands on today's row either way, so a same-day refund
  // decrements the row that was actually charged.
  let used = (row as unknown as Record<string, number>)[meter] ?? 0;
  if (lifetime) {
    const total = await prisma.dailyUsage.aggregate({
      where: { userId },
      _sum: { [meter]: true },
    } as never);
    used =
      ((total as { _sum?: Record<string, number | null> })._sum?.[meter] ?? used) || used;
  }

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
          : lifetime
            ? `The free plan includes ${limit} ${LABEL[meter]} in total, and you have used them. Unlock a company for ₹99 or get a Season Pass — there is nothing to wait for.`
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
export async function refund(userId: string, meter: Meter): Promise<void> {
  // The user is re-read for one column. A refund has to decrement the SAME row
  // the reservation incremented, and which row that is depends on which day it
  // is where they are — so guessing the zone here would, at midnight, hand the
  // unit back into tomorrow and leave today's count permanently one too high.
  const user = await prisma.user
    .findUnique({ where: { id: userId }, select: { timezone: true } })
    .catch(() => null);
  const date = localDate(user?.timezone ?? DEFAULT_TIMEZONE);
  await prisma.dailyUsage
    .updateMany({
      where: { userId, localDate: date, [meter]: { gt: 0 } },
      data: { [meter]: { decrement: 1 } },
    })
    .catch(() => null);
}

/** Read-only snapshot for the dashboard. Never mutates. Reports the same
 *  window `reserve` counts: lifetime totals for a free account's model-priced
 *  meters, today for everything else — a dashboard that showed "0 used today"
 *  beside a refusal about a lifetime cap would look like a bug. */
export async function usageToday(
  userId: string,
): Promise<Record<Meter, { used: number; limit: number; lifetime: boolean }>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, planExpiresAt: true, role: true, timezone: true },
  });
  const limits = limitsFor(user ?? {});
  const isFree = effectivePlan(user ?? {}) === "free";
  const row = await prisma.dailyUsage.findUnique({
    where: {
      userId_localDate: { userId, localDate: localDate(user?.timezone ?? DEFAULT_TIMEZONE) },
    },
  });
  const totals = isFree
    ? await prisma.dailyUsage.aggregate({
        where: { userId },
        _sum: { variantRuns: true, adviceRuns: true },
      })
    : null;
  const meters: Meter[] = ["variantRuns", "adviceRuns", "uploads"];
  const out = {} as Record<Meter, { used: number; limit: number; lifetime: boolean }>;
  for (const m of meters) {
    const lifetime = isFree && m !== "uploads";
    out[m] = {
      used: lifetime
        ? ((totals?._sum as Record<string, number | null> | undefined)?.[m] ?? 0)
        : ((row as unknown as Record<string, number> | null)?.[m] ?? 0),
      limit: limits[LIMIT_KEY[m]],
      lifetime,
    };
  }
  return out;
}

/**
 * Is this a timezone the runtime will accept?
 *
 * The value arrives from `Intl.DateTimeFormat().resolvedOptions().timeZone` in
 * a browser, which means it arrives from a request body and is worth exactly as
 * much trust as anything else that does. An unknown zone stored on a user makes
 * every later `toLocaleDateString` throw — caught in `localDate`, but a caught
 * exception on every quota check for one account is a bug that hides.
 *
 * Checked by asking the platform rather than by matching a pattern: the IANA
 * database gains and loses zones, and a regex over `Region/City` accepts
 * `Nonsense/Nowhere` while rejecting `UTC`.
 */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
