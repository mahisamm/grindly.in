/**
 * Rewrite batches, as things that exist rather than connections held open.
 *
 * A batch is several model calls plus up to four headless Chromium renders:
 * minutes, not seconds. It used to run inside the POST that started it, and
 * that shape had one failure the product could not survive — the work existed
 * only as an open HTTP request. Close the tab, walk into a lift, let a phone
 * sleep, and the server finished the job, wrote the rows and charged the quota
 * while the person who asked for it saw a spinner disappear and nothing arrive.
 * There was no way for them to find out it had worked.
 *
 * So the POST creates a row, hands back its id and returns. The work runs after
 * the response via `after()`, reports its progress onto that row, and the page
 * polls it. A cold page load finds the run again; a lost connection costs
 * nothing.
 *
 * WHAT THIS IS NOT is a job queue. There is no worker fleet, no claim/release,
 * no retry. The previous build had all of that, for auto-applying to job boards
 * where a task takes minutes and fails halfway; it cost two extra processes to
 * deploy and a whole class of bug where a job is claimed and never released.
 * A rewrite is one function call that either finishes or does not, inside the
 * same process that started it.
 *
 * The honest limit of that: a deploy or a crash mid-run leaves a row saying
 * `running` for a process that no longer exists. `reapStaleRuns` is what turns
 * that into a message instead of a spinner that never stops.
 */
import { prisma } from "./prisma";

/**
 * How long a run may claim to be running before we stop believing it.
 *
 * Above the 420s the agent bridge allows a variants command, with room for a
 * slow interpreter start and the database writes either side. Anything past
 * this was killed by a deploy, an OOM, or the box restarting — the process that
 * would have updated the row is gone, so nothing else will ever move it.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Kill switches for runs in flight, by run id.
 *
 * In-process and deliberately not persisted: the handle is a function that
 * signals a child process of THIS server, and it is meaningless anywhere else.
 * A restart clears the map and orphans nothing that `reapStaleRuns` will not
 * catch.
 */
const inFlight = new Map<string, () => void>();

export function holdRun(runId: string, kill: () => void): void {
  inFlight.set(runId, kill);
}

export function releaseRun(runId: string): void {
  inFlight.delete(runId);
}

/** Stop a run that is still ours to stop. Returns whether there was one. */
export function killRun(runId: string): boolean {
  const kill = inFlight.get(runId);
  if (!kill) return false;
  try {
    kill();
  } catch {
    return false;
  }
  inFlight.delete(runId);
  return true;
}

/**
 * Mark runs that cannot still be running as failed.
 *
 * Called on the read path rather than from a scheduler, for the same reason the
 * rate-limit sweep is: there is no scheduler in this deployment, and the only
 * moment anyone cares whether a run is stale is the moment they look at it.
 *
 * Scoped to one resume so a page load does not scan the table.
 */
export async function reapStaleRuns(resumeId: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  await prisma.variantRun
    .updateMany({
      where: { resumeId, status: "running", startedAt: { lt: cutoff } },
      data: {
        status: "failed",
        stage: "Stopped",
        error:
          "This rebuild was interrupted — the server restarted while it was working. " +
          "Nothing was charged against your daily limit. Start it again.",
        finishedAt: new Date(),
      },
    })
    .catch((e) => console.error("[runs] reap failed:", (e as Error).message));
}

/** Is there already a batch working on this resume? */
export async function activeRun(resumeId: string) {
  await reapStaleRuns(resumeId);
  return prisma.variantRun.findFirst({
    where: { resumeId, status: "running" },
    orderBy: { startedAt: "desc" },
  });
}
