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
  const { count } = await prisma.browserTask.updateMany({
    where: { state: { in: [...RECLAIMABLE] }, leaseExpiresAt: { lt: now } },
    data: { state: "queued", leaseTokenHash: null, leaseExpiresAt: null },
  });
  return count;
}

export type ClaimedTask = {
  id: string;
  url: string;
  host: string;
  leaseToken: string;
  leaseExpiresAt: Date;
};

/**
 * Hand exactly one queued task to one browser.
 *
 * The update is conditioned on the row still being `queued`, so two browsers
 * signed into the same account cannot both walk away believing they own it —
 * whoever loses updates zero rows and gets nothing to do.
 */
export async function claimNextTask(userId: string): Promise<ClaimedTask | null> {
  await reclaimExpiredTasks();

  const candidate = await prisma.browserTask.findFirst({
    where: { userId, state: "queued", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    select: { id: true, url: true, host: true },
  });
  if (!candidate) return null;

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
    },
  });
  if (count !== 1) return null; // lost the race; the next poll will find another

  return { id: candidate.id, url: candidate.url, host: candidate.host, leaseToken: raw, leaseExpiresAt: expires };
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
