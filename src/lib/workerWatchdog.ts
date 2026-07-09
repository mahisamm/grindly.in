/**
 * Detects a dead/crashed Python worker container and pages ops via Slack.
 *
 * The worker's Docker healthcheck + `restart: unless-stopped` already recover
 * from a crash or OOM-kill automatically — but recovery is silent. Nobody
 * finds out unless they happen to open /admin/agent-health. This watches the
 * one signal a crashed worker can't fake: agent_runs rows that stop moving.
 *
 *   - status='running' and untouched for 30min  -> matches agent/run_queue.py's
 *     STALE_LOCK_MS. A live worker's serve() loop calls reclaim_stale() on
 *     every drain cycle and self-heals this within seconds, so if it's still
 *     stuck at 30min the process that held the lock is gone.
 *   - status='queued' and untouched for 15min   -> nothing is claiming work.
 *
 * Runs inside the long-lived Next.js server process (wired from
 * instrumentation.ts's register() hook), not as a separate service.
 */
import { prisma } from "@/lib/prisma";
import { sendMessage } from "@/lib/adapters/slack";

const STALE_RUNNING_MS = 30 * 60 * 1000;
const STALE_QUEUED_MS = 15 * 60 * 1000;
const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // one page per hour max, even if still down

// scripts/backup-drill.sh dumps + restore-drills daily and writes one row
// here. Missing this window by more than a day+slack means the drill
// container is down or wedged, not just running a little late.
const STALE_BACKUP_MS = 36 * 60 * 60 * 1000;

const OPS_CHANNEL = process.env.OPS_SLACK_CHANNEL || "ops-alerts";

let lastAlertAt = 0;
let lastBackupAlertAt = 0;

/** Test-only: the cooldown timers are module-level state, so tests need a way
 * to reset them between cases instead of bleeding alerts across `it()` blocks. */
export function __resetWatchdogCooldown(): void {
  lastAlertAt = 0;
  lastBackupAlertAt = 0;
}

export async function checkWorkerHeartbeat(): Promise<void> {
  try {
    const [staleRunning, staleQueued] = await Promise.all([
      prisma.agentRun.count({
        where: { status: "running", updatedAt: { lt: new Date(Date.now() - STALE_RUNNING_MS) } },
      }),
      prisma.agentRun.count({
        where: { status: "queued", createdAt: { lt: new Date(Date.now() - STALE_QUEUED_MS) } },
      }),
    ]);

    if (staleRunning === 0 && staleQueued === 0) return;

    const now = Date.now();
    if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
    lastAlertAt = now;

    await sendMessage({
      channel: OPS_CHANNEL,
      text:
        `:rotating_light: *Worker looks dead* — ${staleRunning} run(s) stuck "running" >30min, ` +
        `${staleQueued} job(s) stuck "queued" >15min unclaimed. Container likely crashed or OOMed ` +
        `and Docker's auto-restart hasn't reclaimed the queue. Check \`docker compose logs worker\`.`,
    });
  } catch (e) {
    console.error("[watchdog] heartbeat check failed:", e);
  }
}

export async function checkBackupHealth(): Promise<void> {
  try {
    const rows = await prisma.$queryRaw<
      { last_restore_at: Date | null; last_restore_ok: boolean | null }[]
    >`SELECT last_restore_at, last_restore_ok FROM backup_health WHERE id = 'singleton'`;

    const row = rows[0];
    // No row yet is expected right after a fresh deploy (first drill cycle
    // hasn't completed) — not a failure, nothing to alert on.
    if (!row) return;

    const stale = !row.last_restore_at || Date.now() - new Date(row.last_restore_at).getTime() > STALE_BACKUP_MS;
    const failed = row.last_restore_ok === false;
    if (!stale && !failed) return;

    const now = Date.now();
    if (now - lastBackupAlertAt < ALERT_COOLDOWN_MS) return;
    lastBackupAlertAt = now;

    await sendMessage({
      channel: OPS_CHANNEL,
      text: failed
        ? ":rotating_light: *Backup restore drill failed* — the last dump did not restore cleanly. " +
          "Check `docker compose logs backup` before you need this backup for real."
        : ":rotating_light: *Backup drill is stale* — no successful restore drill in the last 36h. " +
          "The `backup` container may be down. Check `docker compose logs backup`.",
    });
  } catch (e) {
    // Table not existing yet (pre-first-drill) throws here too — same as
    // the "no row" case, this isn't worth paging over.
    console.error("[watchdog] backup health check failed:", e);
  }
}

export function startWorkerWatchdog(): void {
  checkWorkerHeartbeat();
  checkBackupHealth();
  setInterval(checkWorkerHeartbeat, CHECK_INTERVAL_MS);
  setInterval(checkBackupHealth, CHECK_INTERVAL_MS);
}
