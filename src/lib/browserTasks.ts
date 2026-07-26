import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

// Lease mechanics for browser-executed applications.
//
// A lease is short and renewable rather than an assignment, because the
// executor is a browser tab someone can close at any moment. If that happens
// the lease expires and the task returns to the queue — but ONLY from states
// that prove nothing was submitted. A task that reached `submitted` or stopped
// at a human gate is never silently re-run: re-running a submitted application
// is the duplicate this system spends most of its effort preventing.

/** How long one claim is valid without a heartbeat. */
export const LEASE_MS = 10 * 60_000;
/** The extension heartbeats well inside the lease so a slow page never loses it. */
export const HEARTBEAT_MS = 30_000;
/** Attempts before a task stops being retried and waits for a human. */
export const MAX_ATTEMPTS = 3;

export function hashLease(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

/** States a lease may safely be reclaimed FROM — none of them can have submitted. */
const RECLAIMABLE = ["leased", "filling"] as const;

/**
 * Return expired leases to the queue.
 *
 * Deliberately narrow: only `leased`/`filling`, and only past expiry. A task in
 * `awaiting_human` holds no lease and is waiting on the person, not on us;
 * `submitted` is terminal. Reclaiming either would either nag the user or send
 * a second application.
 */
export async function reclaimExpiredTasks(now = new Date()): Promise<number> {
  // Read them first: each one is holding a reserved daily slot that has to go
  // back with it, or a browser closed mid-fill silently burns someone's cap for
  // the rest of the day. Safe precisely because these states prove nothing was
  // submitted — the same reason they are the only ones reclaimed at all.
  const expired = await prisma.browserTask.findMany({
    where: { state: { in: [...RECLAIMABLE] }, leaseExpiresAt: { lt: now } },
    select: { id: true, userId: true, reservedDate: true },
  });
  if (!expired.length) return 0;

  const { count } = await prisma.browserTask.updateMany({
    where: { id: { in: expired.map((t) => t.id) } },
    data: { state: "queued", leaseTokenHash: null, leaseExpiresAt: null, reservedDate: null },
  });
  for (const t of expired) {
    if (t.reservedDate) await releaseDailySlot(t.userId, t.reservedDate);
  }
  return count;
}

/** The user's LOCAL calendar date — "5 a day" has to mean their day. */
export function localDateFor(timezone?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: "numeric", month: "2-digit", day: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: timezone || "Asia/Kolkata" })
      .format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { ...opts, timeZone: "Asia/Kolkata" }).format(new Date());
  }
}

/**
 * Claim one of today's application slots BEFORE handing out the task.
 *
 * Counting rows and then deciding cannot bound anything — two browsers both
 * read 4-of-5, both conclude there is room, and the employer count ends at six
 * under a limit of five. So the limit rides inside the UPDATE's own WHERE and
 * the database decides; whoever loses updates zero rows and is told no.
 *
 * This mirrors agent/db.py's reserve_daily_slot, which the server-side sender
 * has always used. The browser path had no cap at all: a submission through the
 * extension marked the application applied and never touched the ledger, so
 * "Sent today 0/5" would sit at zero while applications went out. The cap the
 * product promises has to hold on every path that can reach an employer.
 */
export async function reserveDailySlot(
  userId: string, cap: number, localDate: string,
): Promise<boolean> {
  if (cap <= 0) return false;
  // Make sure the row exists without disturbing an existing count.
  await prisma.dailyUsage
    .upsert({
      where: { userId_localDate: { userId, localDate } },
      create: { userId, localDate },
      update: {},
    })
    .catch(() => {}); // a racing insert lost; the row is there either way
  const { count } = await prisma.dailyUsage.updateMany({
    where: { userId, localDate, submitted: { lt: cap } },
    data: { submitted: { increment: 1 }, attempted: { increment: 1 } },
  });
  return count === 1;
}

/**
 * Give a reserved slot back — ONLY when it is certain nothing was submitted.
 *
 * `attempted` is deliberately not decremented: the attempt really happened, and
 * that number exists to show a retry-heavy day honestly. The day is recomputed
 * from the user's timezone, so a lease that straddles midnight releases nothing
 * (the guard below stops it going negative) — it under-sends by one rather than
 * risk handing out a sixth slot.
 */
export async function releaseDailySlot(userId: string, localDate: string): Promise<void> {
  await prisma.dailyUsage
    .updateMany({
      where: { userId, localDate, submitted: { gt: 0 } },
      data: { submitted: { decrement: 1 } },
    })
    .catch(() => {});
}

export type ClaimedTask = {
  id: string;
  applicationId: string;
  url: string;
  host: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};

export type ClaimResult =
  | { task: ClaimedTask; reason?: undefined }
  | { task: null; reason: "no_work" | "daily_cap" };

/**
 * Hand exactly one queued task to one browser, against one reserved slot.
 *
 * The slot is taken BEFORE the task is handed out, because the browser can
 * submit the moment it has one — asking permission afterwards is asking after
 * the application has already reached the employer.
 *
 * But it is taken only once there is something to hand out. An idle browser
 * polls every five minutes; reserving on each of those ~288 daily polls and
 * releasing again means the cap depends on ~288 successful releases, and a
 * release is a database write that can fail. One swallowed failure silently
 * eats a slot, and a user who applied to nothing all day finds themselves
 * capped. Peeking first costs one read and removes that entire class of drift.
 *
 * The task update is conditioned on the row still being `queued`, so two
 * browsers signed into the same account cannot both walk away believing they
 * own it — whoever loses updates zero rows and gets nothing to do.
 */
export async function claimNextTask(
  userId: string, cap: number, localDate: string,
): Promise<ClaimResult> {
  await reclaimExpiredTasks();

  const candidate = await prisma.browserTask.findFirst({
    where: { userId, state: "queued", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    select: { id: true, applicationId: true, url: true, host: true },
  });
  if (!candidate) return { task: null, reason: "no_work" };

  // Only now, with real work in hand, and still before the browser gets it.
  if (!(await reserveDailySlot(userId, cap, localDate))) {
    return { task: null, reason: "daily_cap" };
  }

  const raw = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + LEASE_MS);
  const { count } = await prisma.browserTask.updateMany({
    where: { id: candidate.id, state: "queued" },
    data: {
      state: "leased",
      leaseTokenHash: hashLease(raw),
      leaseExpiresAt: expires,
      heartbeatAt: new Date(),
      attempts: { increment: 1 },
      reservedDate: localDate,
    },
  });
  if (count !== 1) {
    // Lost the race; the next poll will find another.
    await releaseDailySlot(userId, localDate);
    return { task: null, reason: "no_work" };
  }

  return {
    task: {
      id: candidate.id,
      applicationId: candidate.applicationId,
      url: candidate.url,
      host: candidate.host,
      leaseToken: raw,
      leaseExpiresAt: expires,
    },
  };
}

/**
 * Confirm a caller still owns a task.
 *
 * Ownership is proven by BOTH the user and the lease token — the user alone is
 * not enough, or one browser could report progress on the task another browser
 * is executing.
 */
export async function ownsTask(userId: string, taskId: string, leaseToken: string) {
  const task = await prisma.browserTask.findFirst({
    where: { id: taskId, userId, leaseTokenHash: hashLease(leaseToken) },
  });
  if (!task) return null;
  if (task.leaseExpiresAt && task.leaseExpiresAt < new Date()) return null;
  return task;
}
