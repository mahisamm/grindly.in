import { NextResponse } from "next/server";
import path from "node:path";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import { getUid } from "@/lib/session";
import { spawnWorkerKick } from "@/lib/workerKick";
import { getQuota } from "@/lib/quota";

/**
 * Triggers one agent run for the current user (resume parse → match → apply →
 * report). Spawns the Python worker detached so the request returns instantly;
 * the worker writes results back to the same SQLite DB the dashboard polls.
 *
 * Always runs live against the user's connected platform (Internshala) via
 * Playwright. `analyzeOnly` runs resume analysis without touching any board.
 */
export async function POST(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const { analyzeOnly } = (await req.json().catch(() => ({}))) as { analyzeOnly?: boolean };

  const user = await prisma.user.findUnique({ where: { id: uid } });
  if (!user) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Live only — there is no mock/demo mode. The agent applies to real listings
  // via the user's connected platform, so nothing fabricated reaches the UI.
  const runMode = "live";

  // A live run applies against a connected platform — without one the worker can
  // only report login_required, so refuse up front instead of enqueueing a
  // doomed job. `analyzeOnly` just scores the resume and needs no platform.
  // (The dashboard already disables the button; this enforces it server-side so
  // a direct API call can't queue a run with nothing connected.)
  if (!analyzeOnly) {
    const quota = await getQuota(uid, user.plan);
    if (quota.remaining === 0) {
      return NextResponse.json(
        {
          error: quota.kind === "trial"
            ? "Your 5-application free trial is complete. Upgrade to Plus or Pro to continue."
            : `Your ${quota.cap}-application daily limit is reached. Try again tomorrow.`,
          code: quota.kind === "trial" ? "trial_exhausted" : "daily_limit_reached",
          quota,
        },
        { status: 402 },
      );
    }
    const connected =
      user.internshalaConnected ||
      (await prisma.userIntegration
        .count({ where: { userId: uid, status: "connected" } })
        .catch(() => 0)) > 0;
    if (!connected) {
      return NextResponse.json(
        { error: "Connect at least one job platform before running the agent." },
        { status: 400 },
      );
    }
  }

  const root = process.cwd();
  const worker = path.join(root, "agent", "worker.py");
  try { await fsp.access(worker); } catch {
    return NextResponse.json({ error: "worker not installed" }, { status: 500 });
  }

  // Enqueue in the DB-backed run queue (idempotent: reuse any queued/running job
  // for this user). The worker fleet (worker.py --serve) drains it — so the web
  // app does NOT need Python. The spawn below is only a best-effort local "kick"
  // so a dev box without a running worker processes immediately; in prod (slim
  // web image) it no-ops and the worker drains the queue.
  let run;
  if (analyzeOnly) {
    run = await prisma.agentRun.create({ data: { userId: uid, mode: "analyze" } });
  } else {
    const existing = await prisma.agentRun.findFirst({
      where: { userId: uid, status: { in: ["queued", "running"] } },
    });
    run = existing ?? (await prisma.agentRun.create({ data: { userId: uid, mode: runMode } }));
  }

  spawnWorkerKick(root, uid);

  return NextResponse.json({ ok: true, mode: analyzeOnly ? "analyze" : runMode, runId: run.id });
}

/**
 * GET /api/agent/run?id=<runId> — poll the result of a run the dashboard kicked
 * off, so the UI can show "applied X / matched Y" or a real error instead of a
 * blind 6-second spinner.
 */
export async function GET(req: Request) {
  const uid = await getUid();
  if (!uid) return NextResponse.json({ error: "no session" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

  const run = await prisma.agentRun.findFirst({ where: { id, userId: uid } });
  if (!run) return NextResponse.json({ error: "not found" }, { status: 404 });

  let result: unknown = null;
  if (run.result) { try { result = JSON.parse(run.result); } catch { result = null; } }

  return NextResponse.json({
    status: run.status, // queued | running | done | failed | cancelled
    result,
    error: run.error ?? null,
  });
}
