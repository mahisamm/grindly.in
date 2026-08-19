/**
 * Deleting the operational rows nobody will read again.
 *
 * Three tables in this database only ever grow: `rate_limit_entries` (swept by
 * lib/rateLimit.ts already), `audit_logs`, and resolved `error_events`. None of
 * them has a natural end — an audit row is written on every signup, login,
 * upload, rewrite and payment, and nothing has ever deleted one. On a 3.9 GB
 * box the first symptom of that is not a full disk, it is the admin page
 * getting slower every week.
 *
 * Two windows, and they differ because the rows differ:
 *
 *   * Audit logs live 180 days. Long enough to answer "what happened to this
 *     account" for any dispute a user is realistically going to raise, and to
 *     cover a full placement season plus the one after it.
 *
 *   * A RESOLVED error lives 30 days. It has already been looked at and dealt
 *     with; keeping it is keeping a closed ticket. An UNRESOLVED error is never
 *     deleted here at any age, because "this has been broken for a year" is
 *     precisely the thing you want the table to still be able to tell you.
 *
 * Opportunistic, 1-in-N, like the rate-limit sweep and for the same reason:
 * there is no scheduler in this deployment to hang a cron off, and adding one
 * to delete a few hundred rows would be more moving parts than the problem
 * deserves. Both DELETEs hit an index on the timestamp they filter by.
 */
import { prisma } from "./prisma";

export const AUDIT_RETENTION_DAYS = 180;
export const RESOLVED_ERROR_RETENTION_DAYS = 30;

/** One in this many calls actually sweeps. */
const SWEEP_ONE_IN = 200;

const DAY_MS = 86_400_000;

export function cutoff(days: number, now = new Date()): Date {
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Delete what is past its window. Exported for the test and for any future
 * scheduled caller; ordinary code should use `maybeSweep`.
 *
 * Never throws. Housekeeping that can take a request down with it is worse than
 * housekeeping that silently does not happen.
 */
export async function sweepRetention(now = new Date()): Promise<{
  auditLogs: number;
  errorEvents: number;
}> {
  const result = { auditLogs: 0, errorEvents: 0 };
  try {
    const audit = await prisma.auditLog.deleteMany({
      where: { createdAt: { lt: cutoff(AUDIT_RETENTION_DAYS, now) } },
    });
    result.auditLogs = audit.count;
  } catch (e) {
    console.error("[retention] audit sweep failed:", (e as Error).message);
  }
  try {
    const errors = await prisma.errorEvent.deleteMany({
      where: {
        // Both conditions matter. Without the null check this deletes an
        // outstanding bug just because it is old, which is the opposite of what
        // an error table is for.
        resolvedAt: { not: null, lt: cutoff(RESOLVED_ERROR_RETENTION_DAYS, now) },
      },
    });
    result.errorEvents = errors.count;
  } catch (e) {
    console.error("[retention] error sweep failed:", (e as Error).message);
  }
  return result;
}

/**
 * Sweep on roughly one call in `SWEEP_ONE_IN`.
 *
 * Deliberately not awaited by its caller — see lib/audit.ts. The whole body is
 * inside `sweepRetention`'s try/catch for the reason the rate limiter learned
 * the hard way: a synchronous throw in an unawaited promise is an unhandled
 * rejection, and Node treats that as fatal.
 */
export function maybeSweepRetention(): void {
  if (Math.random() * SWEEP_ONE_IN >= 1) return;
  void sweepRetention().then(({ auditLogs, errorEvents }) => {
    if (auditLogs || errorEvents) {
      console.log(`[retention] swept ${auditLogs} audit rows, ${errorEvents} resolved errors`);
    }
  });
}
